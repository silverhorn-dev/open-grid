// ================= MEDIA & COMPRESSION =================
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
        state.myProfile.avatar = base64;
        document.getElementById('edit-avatar-preview').src = base64;
        await saveUserProfile();
        showToast('Profilbild aktualisiert.', 'success');
    } catch (e) { showToast('Fehler bei Avatar-Upload.', 'error'); }
}

async function handleGalleryUpload(input) {
    if (!input.files?.[0]) return;
    if (!state.myProfile.gallery) state.myProfile.gallery = [];
    try {
        const base64 = await compressImage(input.files[0], 800, 800, 0.75);
        const imgId = 'img_' + window.crypto.randomUUID();
        await cacheMedia(imgId, base64, 1);
        state.myProfile.gallery.push({ id: imgId, version: 1 });
        renderEditGallery();
        await saveUserProfile();
        showToast('Bild zur Galerie hinzugefuegt.', 'success');
    } catch (e) { showToast('Fehler beim Upload.', 'error'); }
    input.value = '';
}

function removeGalleryImage(id) {
    state.myProfile.gallery = state.myProfile.gallery.filter(g => g.id !== id);
    deleteDatabaseRecord('media', id);
    renderEditGallery();
    saveUserProfile();
}

async function renderEditGallery() {
    if (!state.myProfile.gallery) state.myProfile.gallery = [];
    const container = document.getElementById('edit-gallery-container');
    if (!container) return;

    const addBtnHtml = `<label id="add-gallery-btn" class="w-20 h-20 rounded-xl bg-slate-950 border border-dashed border-slate-700 flex flex-col items-center justify-center cursor-pointer hover:border-brand-500 hover:text-brand-400 text-slate-500 transition shrink-0"><i class="fa-solid fa-plus text-xl"></i><input type="file" accept="image/*" class="hidden" onchange="handleGalleryUpload(this)"></label>`;
    const imagesHtml = await Promise.all(state.myProfile.gallery.map(async (meta) => {
        const media = await loadMedia(meta.id);
        if (!media) return '';
        return `<div class="w-20 h-20 rounded-xl overflow-hidden relative group border border-slate-800 shrink-0"><img src="${media.data}" class="w-full h-full object-cover"><button onclick="removeGalleryImage('${meta.id}')" class="absolute top-1 right-1 w-6 h-6 bg-red-600 hover:bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition shadow-lg flex items-center justify-center text-xs"><i class="fa-solid fa-xmark"></i></button></div>`;
    }));
    container.innerHTML = imagesHtml.join('') + addBtnHtml;
}

// ================= DYNAMIC FORM =================
function renderProfileForm(containerId = 'dynamic-profile-form') {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    const schemaInput = document.getElementById('schema-json-input');
    if (schemaInput) schemaInput.value = JSON.stringify(PROFILE_SCHEMA, null, 2);

    if (containerId === 'dynamic-profile-form') {
        document.getElementById('edit-avatar-preview').src = localAvatar(state.myProfile.avatar);
        renderEditGallery();
    }

    PROFILE_SCHEMA.forEach(field => {
        const wrapper = document.createElement('div');
        // Freitextfelder ("Ueber mich") nehmen die ganze Breite ein.
        wrapper.className = field.type === 'description' ? 'space-y-1 md:col-span-2' : 'space-y-1';

        const label = document.createElement('label');
        label.className = 'text-xs font-bold text-slate-400';
        label.textContent = field.label + (field.required ? ' *' : '');
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
            privacy.append(checkbox, document.createTextNode('nur fuer Matches'));
            wrapper.appendChild(privacy);
        }

        const currentValue = state.myProfile.fields[field.key] ?? field.default ?? '';
        if (state.myProfile.fields[field.key] === undefined && field.default !== undefined) {
            state.myProfile.fields[field.key] = currentValue;
        }
        let input;

        if (field.type === 'select' || field.type === 'multiselect') {
            input = document.createElement('select');
            input.multiple = field.type === 'multiselect';
            if (input.multiple) input.size = Math.min(field.options.length, 4);
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

        input.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base md:text-sm text-slate-100 focus:outline-none focus:border-brand-500';
        if (field.type === 'description') input.classList.add('min-h-36', 'resize-y', 'leading-relaxed');

        input.onchange = (e) => {
            if (field.type === 'multiselect') {
                state.myProfile.fields[field.key] = Array.from(e.target.selectedOptions, option => option.value);
            } else if (field.type === 'number') {
                state.myProfile.fields[field.key] = e.target.value === '' ? '' : Number(e.target.value);
            } else if (field.type === 'tag') {
                state.myProfile.fields[field.key] = e.target.value.split(',').map(value => value.trim()).filter(Boolean);
            } else {
                state.myProfile.fields[field.key] = e.target.value;
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
        errorOutput.textContent = `Bitte fuelle das Pflichtfeld "${missingField.label}" aus.`;
        errorOutput.classList.remove('hidden');
        return;
    }

    button.disabled = true;
    errorOutput.classList.add('hidden');
    state.myProfile.version = 1;
    state.myProfile.updatedAt = Date.now();
    const persisted = await cacheOwnProfile();
    if (!persisted) {
        errorOutput.textContent = 'Das Profil konnte nicht verschluesselt gespeichert werden. Lokaler Speicher ist nicht verfuegbar.';
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
        showToast('Profile schema applied.', 'success');
        logDebug('Dynamic profile schema updated.');
    } catch (error) {
        showToast(`Invalid profile schema: ${error.message}`, 'error');
    }
}

async function saveUserProfile() {
    state.myProfile.version = (state.myProfile.version || 0) + 1;
    state.myProfile.updatedAt = Date.now();
    const persisted = await cacheOwnProfile();
    await registerWithWorkerGrid();
    showToast(
        persisted
            ? 'Profile saved & broadcasted!'
            : 'Profile broadcasted for this session; encrypted local storage is unavailable.',
        persisted ? 'success' : 'warning'
    );
}
