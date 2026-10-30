// ================= MEDIA & COMPRESSION =================
// Kantenlaenge der grossen Profilbild-Fassung (Bildbetrachter), das Profil selbst traegt nur 200 px.
const AVATAR_FULL_EDGE = 1280;

// ----- Eigenes Profil fuer "Chat & Freunde" -----
// Standard: ein Profil fuer alles. Eingeschaltet (`myProfile.social.enabled`) hat "Chat & Freunde" eigene
// Felder, Profilbild und Galerie; Peers in dieser Liste bekommen sie (matching.js buildProfilePayloadFor),
// alle anderen das Entdecken-Profil. Beim Einschalten wird das bisherige Profil als Start kopiert.
function socialProfileEnabled() {
    return state.myProfile?.social?.enabled === true;
}

// Teil des eigenen Profils fuer einen Bereich ('discovery' | 'social'): { fields, avatar, avatarFull, gallery }.
function profilePart(area) {
    return area === 'social' && socialProfileEnabled() ? state.myProfile.social : state.myProfile;
}

function currentModeArea() {
    return typeof isSocialMode === 'function' && isSocialMode() ? 'social' : 'discovery';
}

// Bereich, der im Profil-Editor gerade bearbeitet wird (Auswahl nur bei eigenem Social-Profil).
function editingProfileArea() {
    if (!socialProfileEnabled()) return currentModeArea();
    return state.profileEditArea === 'social' || state.profileEditArea === 'discovery' ? state.profileEditArea : currentModeArea();
}

function editingProfilePart() {
    return profilePart(editingProfileArea());
}

// Felder des bearbeiteten Bereichs: das Schema des aktiven Modus, sonst das des anderen Bereichs.
function editingProfileSchema() {
    const area = editingProfileArea();
    if (area === currentModeArea()) return PROFILE_SCHEMA;
    const schemas = typeof PROFILE_SCHEMAS === 'object' && PROFILE_SCHEMAS ? PROFILE_SCHEMAS : {};
    return (area === 'social' ? schemas.friends || schemas.chat : schemas.discovery) || PROFILE_SCHEMA;
}

// Medien-Ids, die ein anderer Profilteil noch nutzt (Kopie beim Einschalten teilt Bilder).
function profileMediaInUse(mediaId, exceptPart) {
    return [state.myProfile, state.myProfile.social].filter(part => part && part !== exceptPart)
        .some(part => part.avatarFull?.id === mediaId || (part.gallery || []).some(item => item.id === mediaId));
}

async function setSocialProfileEnabled(enabled) {
    const social = state.myProfile.social;
    if (enabled && !social?.fields) {
        state.myProfile.social = {
            enabled: true,
            fields: JSON.parse(JSON.stringify(state.myProfile.fields || {})),
            avatar: state.myProfile.avatar || null,
            avatarFull: state.myProfile.avatarFull ? { ...state.myProfile.avatarFull } : null,
            gallery: (state.myProfile.gallery || []).map(item => ({ ...item }))
        };
    } else if (social) {
        // Aus: die Social-Werte bleiben gespeichert (wieder an = wie vorher).
        state.myProfile.social = { ...social, enabled: Boolean(enabled) };
    }
    state.profileEditArea = null;
    renderSocialProfileControls();
    renderProfileForm();
    await saveUserProfile();
}

function setProfileEditArea(area) {
    if (!socialProfileEnabled() || !['discovery', 'social'].includes(area)) return;
    if (state.profileDirty && !window.confirm(t('profile.discardUnsavedChanges'))) {
        renderSocialProfileControls();
        return;
    }
    if (state.profileDirty) discardProfileChanges();
    state.profileEditArea = area;
    renderSocialProfileControls();
    renderProfileForm();
}

// Schalter + Bereichsauswahl im Profil. Nur wenn beide Bereiche an sind (sonst gibt es nichts zu trennen).
function renderSocialProfileControls() {
    const card = document.getElementById('social-profile-controls');
    if (!card) return;
    const bothAreas = typeof scopeIncludes !== 'function' || (scopeIncludes('social') && scopeIncludes('discovery'));
    card.classList.toggle('hidden', !bothAreas);
    const toggle = document.getElementById('social-profile-toggle');
    if (toggle) toggle.checked = socialProfileEnabled();
    const chooser = document.getElementById('profile-area-chooser');
    chooser?.classList.toggle('hidden', !socialProfileEnabled());
    const area = editingProfileArea();
    chooser?.querySelectorAll('[data-profile-area]').forEach(button => {
        const active = button.dataset.profileArea === area;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}
function compressImage(file, maxWidth, maxHeight, quality = 0.8) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                let { width, height } = img;
                if (width > height) { if (width > maxWidth) { height = Math.round((height *= maxWidth / width)); width = maxWidth; } }
                else { if (height > maxHeight) { width = Math.round((width *= maxHeight / height)); height = maxHeight; } }
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
        };
    });
}

async function handleAvatarUpload(input) {
    if (!input.files?.[0]) return;
    try {
        // Starke Komprimierung, da der Server in app.js bei 50.000 Zeichen abschneidet
        const base64 = await compressImage(input.files[0], 200, 200, 0.6);
        // Grosse Fassung fuer den Bildbetrachter: liegt nur lokal, andere holen sie wie Galeriebilder per
        // P2P (IMAGE_REQUEST), sofern sie das Profilbild sehen duerfen. Im Profil steht nur der Verweis.
        const full = await compressImage(input.files[0], AVATAR_FULL_EDGE, AVATAR_FULL_EDGE, 0.82);
        const part = editingProfilePart();
        const previousFull = part.avatarFull?.id;
        const fullId = `avatar_${window.crypto.randomUUID()}`;
        await cacheMedia(fullId, full, 1);
        part.avatarFull = { id: fullId, version: 1, sha256: await sha256Base64(full) };
        if (previousFull && !profileMediaInUse(previousFull, part)) deleteDatabaseRecord('media', previousFull).catch(() => {});
        part.avatar = base64;
        document.getElementById('edit-avatar-preview').src = base64;
        await saveUserProfile();
        showToast(t('profile.pictureUpdated'), 'success');
    } catch (e) { showToast(t('profile.pictureUploadFailed'), 'error'); }
}

async function handleGalleryUpload(input) {
    if (!input.files?.[0]) return;
    const part = editingProfilePart();
    if (!part.gallery) part.gallery = [];
    try {
        const base64 = await compressImage(input.files[0], 800, 800, 0.75);
        const imgId = 'img_' + window.crypto.randomUUID();
        await cacheMedia(imgId, base64, 1);
        part.gallery.push({ id: imgId, version: 1, sha256: await sha256Base64(base64) });
        renderEditGallery();
        await saveUserProfile();
        showToast(t('profile.imageAddedToGallery'), 'success');
    } catch (e) { showToast(t('profile.uploadFailed'), 'error'); }
    input.value = '';
}

function removeGalleryImage(id) {
    const part = editingProfilePart();
    part.gallery = (part.gallery || []).filter(g => g.id !== id);
    if (!profileMediaInUse(id, part)) deleteDatabaseRecord('media', id);
    renderEditGallery();
    saveUserProfile();
}

async function renderEditGallery() {
    const part = editingProfilePart();
    if (!part.gallery) part.gallery = [];
    const container = document.getElementById('edit-gallery-container');
    if (!container) return;

    // DOM statt HTML-Strings: keine Inline-Handler (strikte CSP) und kein innerHTML mit Daten.
    const tiles = await Promise.all(part.gallery.map(async meta => {
        const media = await loadMedia(meta.id);
        if (!media || !isSafeInlineImage(media.data)) return null;
        const tile = document.createElement('div');
        tile.className = 'w-20 h-20 rounded-xl overflow-hidden relative group border border-slate-800 shrink-0';
        const image = document.createElement('img');
        image.src = media.data;
        image.alt = '';
        image.className = 'w-full h-full object-cover';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'absolute top-1 right-1 w-6 h-6 bg-red-600 hover:bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition shadow-lg flex items-center justify-center text-xs';
        remove.setAttribute('aria-label', t('common.removeImage'));
        remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        remove.onclick = () => removeGalleryImage(meta.id);
        tile.append(image, remove);
        return tile;
    }));

    const addButton = document.createElement('label');
    addButton.id = 'add-gallery-btn';
    addButton.className = 'w-20 h-20 rounded-xl bg-slate-950 border border-dashed border-slate-700 flex flex-col items-center justify-center cursor-pointer hover:border-brand-500 hover:text-brand-400 text-slate-500 transition shrink-0';
    addButton.innerHTML = '<i class="fa-solid fa-plus text-xl"></i>';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.className = 'hidden';
    fileInput.onchange = () => handleGalleryUpload(fileInput);
    addButton.appendChild(fileInput);

    container.replaceChildren(...tiles.filter(Boolean), addButton);
}

// ================= DYNAMIC FORM =================
// ----- Ungespeicherte Aenderungen -----
// Felder schreiben bei "change" in state.myProfile.fields; gespeichert (verteilt) wird erst mit
// "Speichern". Solange etwas abweicht, steht unten eine Leiste mit Verwerfen/Speichern.
function snapshotProfileFields() {
    state.profileSnapshot = JSON.stringify(editingProfilePart().fields || {});
    setProfileDirty(false);
}

function setProfileDirty(dirty) {
    state.profileDirty = dirty;
    document.getElementById('profile-save-bar')?.classList.toggle('hidden', !dirty);
}

function refreshProfileDirty() {
    setProfileDirty(state.profileSnapshot !== null && JSON.stringify(editingProfilePart().fields || {}) !== state.profileSnapshot);
}

function discardProfileChanges() {
    if (state.profileSnapshot) editingProfilePart().fields = JSON.parse(state.profileSnapshot);
    setProfileDirty(false);
    renderProfileForm();
}

function renderProfileForm(containerId = 'dynamic-profile-form') {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    const schemaInput = document.getElementById('schema-json-input');
    if (schemaInput) schemaInput.value = JSON.stringify(PROFILE_SCHEMA, null, 2);
    // Profil-Editor: der gewaehlte Bereich (eigenes Social-Profil); Onboarding: immer das Hauptprofil.
    const editor = containerId === 'dynamic-profile-form';
    const part = editor ? editingProfilePart() : state.myProfile;
    if (!part.fields) part.fields = {};
    const schema = editor ? editingProfileSchema() : PROFILE_SCHEMA;

    if (editor) {
        renderSocialProfileControls();
        document.getElementById('edit-avatar-preview').src = localAvatar(part.avatar);
        renderEditGallery();
        // Neu zeichnen (z. B. Moduswechsel) behaelt ungespeicherte Aenderungen und ihre Leiste.
        if (!state.profileDirty) snapshotProfileFields();
        container.oninput = () => setProfileDirty(true);
        container.onchange = () => refreshProfileDirty();
    }

    schema.forEach(field => {
        const wrapper = document.createElement('div');
        // Freitextfelder ("Ueber mich") nehmen die ganze Breite ein.
        wrapper.className = field.type === 'description' ? 'space-y-1 md:col-span-2' : 'space-y-1';

        const label = document.createElement('label');
        label.className = 'text-xs font-bold text-slate-400';
        label.textContent = localizedText(field.label) + (field.required ? ' *' : '');
        wrapper.appendChild(label);
        // Sichtbarkeitsstufe 2: einzelne Felder nur fuer Matches.
        if (containerId === 'dynamic-profile-form' && getMyVisibility() === 2) {
            const privacy = document.createElement('label');
            privacy.className = 'ml-3 inline-flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'accent-brand-500';
            checkbox.checked = (state.myProfile.privateFields || []).includes(field.key);
            checkbox.onchange = () => togglePrivateField(field.key, checkbox.checked);
            privacy.append(checkbox, document.createTextNode(t('profile.matchesOnly')));
            wrapper.appendChild(privacy);
        }

        const currentValue = part.fields[field.key] ?? localizedText(field.default) ?? '';
        if (part.fields[field.key] === undefined && field.default !== undefined) {
            part.fields[field.key] = currentValue;
        }
        let input;

        if (field.type === 'multiselect') {
            // Mehrfachauswahl als Chips (eine native Liste mit Mehrfachauswahl ist auf dem Handy muehsam).
            const chips = document.createElement('div');
            chips.className = 'grid-filter-chips profile-chips';
            chips.dataset.profileField = field.key;
            const selected = new Set(Array.isArray(currentValue) ? currentValue : []);
            field.options.forEach(optionValue => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = `grid-filter-chip${selected.has(optionValue) ? ' is-active' : ''}`;
                chip.textContent = localizedText(optionValue);
                chip.setAttribute('aria-pressed', String(selected.has(optionValue)));
                chip.onclick = () => {
                    if (selected.has(optionValue)) selected.delete(optionValue);
                    else selected.add(optionValue);
                    chip.classList.toggle('is-active', selected.has(optionValue));
                    chip.setAttribute('aria-pressed', String(selected.has(optionValue)));
                    part.fields[field.key] = field.options.filter(value => selected.has(value));
                };
                chips.appendChild(chip);
            });
            wrapper.appendChild(chips);
            container.appendChild(wrapper);
            return;
        }
        if (field.type === 'select') {
            input = document.createElement('select');
            // Ohne Pflicht und ohne Standard: leerer Eintrag, sonst stuende still die erste Option da.
            if (!field.required) {
                const empty = document.createElement('option');
                empty.value = '';
                empty.textContent = '–';
                empty.selected = !currentValue;
                input.appendChild(empty);
            }
            field.options.forEach((optionValue) => {
                const option = document.createElement('option');
                option.value = optionValue;
                option.textContent = optionValue;
                option.selected = Array.isArray(currentValue)
                    ? currentValue.includes(optionValue)
                    : currentValue === optionValue;
                input.appendChild(option);
            });
        } else if (field.type === 'description') {
            input = document.createElement('textarea');
            input.rows = 6;
            input.value = currentValue;
            // Waechst mit dem Text mit, damit nichts in einem Mini-Feld scrollt.
            const fitHeight = () => {
                input.style.height = 'auto';
                input.style.height = `${Math.max(input.scrollHeight, 144)}px`;
            };
            input.addEventListener('input', fitHeight);
            requestAnimationFrame(fitHeight);
        } else {
            input = document.createElement('input');
            input.type = field.type === 'number' ? 'number' : 'text';
            input.value = Array.isArray(currentValue) ? currentValue.join(', ') : currentValue;
            if (field.min !== undefined) input.min = field.min;
            if (field.max !== undefined) input.max = field.max;
        }

        input.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base md:text-sm text-slate-100 focus:outline-hidden focus:border-brand-500';
        if (field.type === 'description') input.classList.add('min-h-36', 'resize-y', 'leading-relaxed');

        input.onchange = (e) => {
            if (field.type === 'multiselect') {
                part.fields[field.key] = Array.from(e.target.selectedOptions, option => option.value);
            } else if (field.type === 'number') {
                part.fields[field.key] = e.target.value === '' ? '' : Number(e.target.value);
            } else if (field.type === 'tag') {
                part.fields[field.key] = e.target.value.split(',').map(value => value.trim()).filter(Boolean);
            } else {
                part.fields[field.key] = e.target.value;
            }
        };
        wrapper.appendChild(input);
        container.appendChild(wrapper);
    });
}

let resolveProfileOnboarding = null;

function openProfileOnboarding() {
    renderProfileForm('onboarding-profile-form');
    renderOnboardingModeChooser();
    document.getElementById('profile-onboarding-modal').classList.remove('hidden');
    return new Promise(resolve => {
        resolveProfileOnboarding = resolve;
    });
}

async function completeProfileOnboarding() {
    const errorOutput = document.getElementById('onboarding-profile-error');
    const button = document.getElementById('complete-onboarding-btn');
    const missingField = PROFILE_SCHEMA.find(field => {
        if (!field.required) return false;
        const value = state.myProfile.fields[field.key];
        return value === undefined
            || value === null
            || value === ''
            || (Array.isArray(value) && value.length === 0);
    });
    if (missingField) {
        errorOutput.textContent = t('profile.pleaseFillInRequiredField', { label: localizedText(missingField.label) });
        errorOutput.classList.remove('hidden');
        return;
    }

    button.disabled = true;
    errorOutput.classList.add('hidden');
    state.myProfile.version = 1;
    state.myProfile.updatedAt = Date.now();
    const persisted = await cacheOwnProfile();
    if (!persisted) {
        errorOutput.textContent = t('profile.couldNotBeStored');
        errorOutput.classList.remove('hidden');
        button.disabled = false;
        return;
    }

    document.getElementById('profile-onboarding-modal').classList.add('hidden');
    renderProfileForm();
    const resolve = resolveProfileOnboarding;
    resolveProfileOnboarding = null;
    resolve?.();
}

function updateProfileSchemaFromJSON() {
    try {
        const schemaInput = document.getElementById('schema-json-input');
        PROFILE_SCHEMA = validateProfileSchema(JSON.parse(schemaInput.value));
        renderProfileForm();
        showToast(t('profile.schemaApplied'), 'success');
        logDebug('Dynamic profile schema updated.');
    } catch (error) {
        showToast(t('profile.invalidProfileSchema', { message: error.message }), 'error');
    }
}

// quiet: ohne Meldung (z. B. wenn sich nur ein unsichtbares Profil-Flag aendert).
async function saveUserProfile({ quiet = false } = {}) {
    state.myProfile.version = (state.myProfile.version || 0) + 1;
    state.myProfile.updatedAt = Date.now();
    const persisted = await cacheOwnProfile();
    await registerWithWorkerGrid();
    if (quiet) {
        snapshotProfileFields();
        return;
    }
    showToast(
        persisted
            ? t('profile.savedAndShared')
            : t('profile.sharedForThisSession'),
        persisted ? 'success' : 'warning'
    );
    snapshotProfileFields();
}
