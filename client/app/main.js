async function refreshPresenceAndGrid() {
    const registered = await registerWithWorkerGrid();
    if (!registered) return;
    await refreshChatControls().catch(error => {
        logDebug(`Could not refresh persistent chat controls: ${error.message}`);
    });
    await fetchPeersFromWorkerGrid();
}

// Ein optionaler Startschritt: Fehler werden protokolliert, der Start laeuft weiter.
async function runStartupStep(name, step) {
    try {
        await step();
    } catch (error) {
        state.startupProblems.push(name);
        console.error(`OpenGrid startup step "${name}" failed.`, error);
        logDebug(`Startschritt "${name}" fehlgeschlagen: ${error?.message || error}`);
    }
}

function reportStartupProblems() {
    if (!state.startupProblems.length) return;
    showToast(CONFIG.DEBUG_MODE
        ? t('app.partlyStartedErrorsIn', { parts: state.startupProblems.join(', ') })
        : t('app.someFeaturesCouldNotBe'), 'warning');
}

// Alles, was sonst unbemerkt verloren ginge, landet im Debug-Log.
// Kein Wiederherstellen der Scrollposition nach dem Neuladen: die Seite darunter soll den festen
// Chat (Smartphone) nicht verschieben.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

window.addEventListener('unhandledrejection', event => {
    logDebug(`Unbehandelter Fehler: ${event.reason?.message || event.reason}`);
});
window.addEventListener('error', event => {
    logDebug(`Skriptfehler: ${event.message} (${event.filename?.split('/').pop() || '?'}:${event.lineno || 0})`);
});

window.onload = async () => {
    updateDebugButtonState();
    const initialRoute = resolveInitialRoute();
    state.applyingRoute = true;
    switchTab(initialRoute.tab);
    state.applyingRoute = false;
    // Deep Link in einen Chat: sofort die Chat-Ansicht zeigen (statt kurz die Liste), der Inhalt
    // kommt, sobald Datenbank und Chatliste bereit sind.
    if (initialRoute.peerId) showChatLoadingPlaceholder();
    window.addEventListener('popstate', handlePopState);
    initImageViewer();
    initSettingsTabs();
    initVideoViewer();
    initSecureSnaps();
    initGestures();
    initSnapEditor();
    initSnapCamera();
    initChatSwitchSwipe();
    initChatScroll();
    initChatInputFocus();
    initSnapLongPress();
    window.addEventListener('online', updateConnectivityIndicator);
    window.addEventListener('offline', updateConnectivityIndicator);
    updateConnectivityIndicator();
    renderAppearanceSettings();
    initThemeSettings();
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeMenu();
    });
    try {
        // Kritisch: ohne Datenbank, Verschluesselung, eigenes Profil, Schluessel und Signaling
        // laeuft nichts. Alles andere ist ein optionaler Schritt mit Fallback (runStartupStep),
        // damit ein einzelner Fehler nicht die ganze App stoppt.
        await initDatabase();
        await initializeStorageEncryption();
        await runStartupStep('App-Modus', loadAppMode);
        const hasLocalProfile = await loadMyLocalProfile();
        if (!hasLocalProfile) await openProfileOnboarding();
        if (!state.myProfile.updatedAt) {
            state.myProfile.version = 1;
            state.myProfile.updatedAt = Date.now();
        }
        await cacheOwnProfile();
        await runStartupStep('Galerie-Hashes', ensureGalleryHashes);
        await runStartupStep('Grid-Cache', loadCachedGridPeers);
        await runStartupStep('Freunde', async () => {
            await loadChatScopes();
            await loadFriendState();
        });
        await runStartupStep('Status', async () => {
            await loadStatusSettings();
            await loadStatuses();
            startStatusCleanup();
        });
        await runStartupStep('Chatliste', async () => {
            await loadChatReads();
            await loadChatPeerIds();
        });
        await runStartupStep('Chat-Wechsel', async () => {
            await loadChatSwitchSettings();
            await loadPullUpSetting();
            await loadListSwitchSettings();
        });
        // Deep Link (/chat/<id>, auch aus einer Push-Benachrichtigung): so frueh wie moeglich oeffnen.
        // Die P2P-Verbindung folgt nach SOCKET_REGISTERED (retryVisiblePeerConnections).
        if (initialRoute.peerId) await runStartupStep('Chat oeffnen', () => applyRoute(initialRoute));
        await runStartupStep('Alben', async () => {
            await loadAlbums();
            await loadAlbumDefaults();
        });
        runStartupStep('Speicher', async () => {
            await requestPersistentStorage();
            await renderStorageUsage(true);
        });
        await runStartupStep('Matches', async () => {
            await loadMatchState();
            renderMatchingSettings();
            await syncChatGate();
        });
        await runStartupStep('Snap-Einstellungen', async () => {
            await loadSnapSettings();
            await loadTraceWatermarkSetting();
        });
        await generateUserIdentityKeys();
        await runStartupStep('Sichtbarkeit', loadGridSettings);
        await runStartupStep('Service Worker', registerServiceWorker);
        connectWorkerWebSocket();
        // Sicherheitsnetz fuer den Deep Link: ist der Chat noch nicht offen (frueher Schritt
        // fehlgeschlagen) oder steht noch der Platzhalter, jetzt mit allem Geladenen erneut oeffnen.
        if (initialRoute.peerId && (state.activeChatPeerId !== initialRoute.peerId || isChatPlaceholderShown())) {
            state.activeChatPeerId = null;
            await runStartupStep('Chat oeffnen (erneut)', () => applyRoute(initialRoute));
        }
        if (!state.activeChatPeerId) updateChatLayout();
        reportStartupProblems();
        renderInviteCard().catch(error => logDebug(`Invite card failed: ${error.message}`));
        if (state.pendingInvite) acceptPendingInvite().catch(error => logDebug(`Invite failed: ${error.message}`));
        handleIncomingShare().catch(error => logDebug(`Share target failed: ${error.message}`));
        const chatInput = document.getElementById('chat-input');
        chatInput.addEventListener('input', () => {
            fitChatInput(chatInput);
            updateComposeButtons();
        });
        updateComposeButtons();
        chatInput.addEventListener('keydown', (event) => {
            // Am Desktop sendet Enter (Shift+Enter = neue Zeile); auf Touch-Tastaturen ist Enter
            // eine neue Zeile und der Senden-Knopf sendet.
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isCoarsePointer()) {
                event.preventDefault();
                sendChatMessage();
            }
        });
        document.addEventListener('visibilitychange', () => {
            syncChatFocus();
            if (document.visibilityState === 'visible') {
                // Zurueck aus dem Hintergrund: Signaling pruefen (oft halb offen), dann aktualisieren.
                checkSignalingHealth('resume');
                refreshPresenceAndGrid();
                // Was waehrend des Hintergrunds im Zwischenspeicher gelandet ist.
                scheduleCacheFetch(0);
            }
        });
        window.addEventListener('online', () => checkSignalingHealth('online'));
        setInterval(() => {
            if (document.visibilityState === 'visible') checkSignalingHealth('interval');
        }, WS_PING_INTERVAL_MS);
        window.addEventListener('storage', event => {
            if (event.key === 'opengrid-router-auth-token' && event.newValue) {
                state.routerAuthToken = event.newValue;
            }
        });
        window.addEventListener('focus', refreshPresenceAndGrid);
        setInterval(() => {
            if (document.visibilityState === 'visible') fetchPeersFromWorkerGrid();
        }, 10000);
        setInterval(() => {
            if (document.visibilityState === 'visible') registerWithWorkerGrid();
        }, 25000);

    } catch (error) {
        console.error('OpenGrid startup failed.', error);
        showToast(CONFIG.DEBUG_MODE ? t('app.startupFailed', { message: error.message }) : t('app.couldNotStartPlease'), 'error');
    }
};
