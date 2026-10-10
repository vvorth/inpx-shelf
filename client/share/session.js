//Кто сейчас пользуется приложением, по ответу get-config.
//Гость - анонимный профиль или профиль не выбран; вошедший - профиль без пароля или с выполненным входом.

export function currentProfile(config = {}) {
    return config.currentUserProfile || {};
}

export function selectedProfile(config = {}, settings = {}) {
    const userId = String(settings.currentUserId || config.currentUserId || '').trim();
    const users = Array.isArray(config.userProfiles) ? config.userProfiles : [];
    return users.find(item => item && item.id === userId) || null;
}

export function isGuest(config = {}) {
    const profile = currentProfile(config);
    return !profile.id || !!profile.anonymousProfile;
}

export function isSignedIn(config = {}) {
    return !!config.profileAuthorized && !isGuest(config);
}

export function isAdmin(config = {}) {
    return isSignedIn(config) && !!currentProfile(config).isAdmin;
}

export function needsLogin(config = {}, settings = {}) {
    const profile = selectedProfile(config, settings);
    return !!(profile && profile.requiresLogin && !config.profileAuthorized);
}

export function initials(name = '') {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length)
        return '?';
    return words.slice(0, 2).map(word => word[0].toUpperCase()).join('');
}
