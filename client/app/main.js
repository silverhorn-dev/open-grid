async function refreshPresenceAndGrid() {
    const registered = await registerWithWorkerGrid();
    if (!registered) return;
    await refreshChatControls().catch(error => {
        logDebug(`Could not refresh persistent chat controls: ${error.message}`);
    });
    await fetchPeersFromWorkerGrid();
}

window.onload = async () => {
    try {
        await initDatabase();
        await initializeStorageEncryption();
        const hasLocalProfile = await loadMyLocalProfile();
        if (!hasLocalProfile) await openProfileOnboarding();
        if (!state.myProfile.updatedAt) {
            state.myProfile.version = 1;
            state.myProfile.updatedAt = Date.now();
        }
        await cacheOwnProfile();
        await loadCachedGridPeers();
        await loadChatPeerIds();
        updateDebugButtonState();
        await generateUserIdentityKeys();
        await registerServiceWorker();
        connectWorkerWebSocket();
        document.getElementById('chat-input').addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendChatMessage();
            }
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refreshPresenceAndGrid();
        });
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

        // Deep Link aus einer Push-Benachrichtigung
        const chatPeerId = new URLSearchParams(window.location.search).get('chat');
        if (chatPeerId) {
            window.history.replaceState(null, '', '/');
            await openChatWithPeer(chatPeerId);
        }
    } catch (error) {
        console.error('OpenGrid startup failed.', error);
        showToast(`Startup failed: ${error.message}`, 'error');
    }
};
