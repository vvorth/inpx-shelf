//Профиль читателя: выбранный профиль и его настройки читалки, нужен ли вход, плашка профиля на панели
//и вход перед действием, которое сохраняется в профиль (закладка, отметка «прочитано»).
import {t, tm} from '../../share/i18n';

export default class ReaderProfile {
    get currentUserId() {
        return this.settings.currentUserId || this.config.currentUserId || '';
    }

    get readerProfileAuthorized() {
        return !!this.config.profileAuthorized;
    }

    get currentSelectedProfile() {
        const users = this.config.userProfiles || [];
        return users.find((item) => item.id === this.currentUserId) || this.config.currentUserProfile || null;
    }

    get currentProfileReaderPreferences() {
        const current = this.currentSelectedProfile || null;
        if (!current || current.anonymousProfile)
            return null;
        if (current.requiresLogin && !this.config.profileAuthorized)
            return null;
        //настройки есть только в currentUserProfile, а не в общем списке профилей (его видит админ)
        const own = this.config.currentUserProfile;
        return (own && own.id === current.id ? own.readerPreferences : current.readerPreferences) || null;
    }

    get readerProfileNeedsLogin() {
        const current = this.currentSelectedProfile;
        return !!(this.currentUserId && current && current.requiresLogin && !this.config.profileAuthorized);
    }

    get readerAnonymousProfile() {
        const current = this.currentSelectedProfile;
        return !!(current && current.anonymousProfile);
    }

    get readerProfileMissing() {
        return !!((!this.currentUserId || this.readerAnonymousProfile) && Array.isArray(this.config.userProfiles) && this.config.userProfiles.length);
    }

    get readerProfileWarningVisible() {
        return !this.isStandaloneMode && (this.readerProfileNeedsLogin || this.readerProfileMissing);
    }

    get readerProfileCanLogin() {
        return !!(this.readerProfileNeedsLogin || this.readerAnonymousProfile || (!this.currentUserId && Array.isArray(this.config.userProfiles) && this.config.userProfiles.length));
    }

    get readerProfileChipLabel() {
        const current = this.currentSelectedProfile;
        if (!current)
            return this.uiText.profileNotSelected;
        const profileName = tm(current.name) || this.uiText.profile;
        if (this.isCompactLayout) {
            if (this.readerProfileCanLogin)
                return this.uiText.profileLoginAction;
            return profileName;
        }
        if (this.readerAnonymousProfile)
            return `${profileName}: ${this.uiText.profileLoginAction}`;
        if (this.readerProfileCanLogin)
            return `${tm(current.name) || this.uiText.profile}: ${this.uiText.profileNeedsLoginShort}`;
        if (this.config.profileAuthorized)
            return profileName;
        return `${tm(current.name) || this.uiText.profile}: ${this.uiText.profileOpenShort}`;
    }

    get readerProfileChipClass() {
        if (!this.currentSelectedProfile)
            return 'reader-profile-chip--missing';
        if (this.readerProfileCanLogin)
            return 'reader-profile-chip--locked';
        if (this.config.profileAuthorized)
            return 'reader-profile-chip--authorized';
        return 'reader-profile-chip--open';
    }

    get readerProfileChipIcon() {
        if (!this.currentSelectedProfile)
            return 'la la-user-slash';
        if (this.readerProfileCanLogin)
            return 'la la-user-lock';
        if (this.config.profileAuthorized)
            return 'la la-user-check';
        return 'la la-user';
    }

    async promptReaderProfileLogin() {
        const api = this.$root.api;
        const target = this.currentSelectedProfile;
        if (!api)
            return false;

        try {
            if (document.fullscreenElement && this.fullscreenActive) {
                try {
                    await document.exitFullscreen();
                    await new Promise(resolve => setTimeout(resolve, 0));
                } catch (fullscreenError) {
                    // Ignore fullscreen exit failures and still attempt to show the dialog.
                }
            }

            await api.showProfileLoginDialog(
                target && !this.config.profileAuthorized && !target.anonymousProfile ? target.login || '' : '',
                {
                    dialogClass: 'std-dialog-card--reader',
                    dialogStyle: this.readerDialogStyle,
                },
            );
            this.profileWarningNotifiedKey = '';
            if (this.bookUid && !this.isStandaloneMode) {
                window.location.reload();
                return true;
            } else if (!this.bookUid && !this.isStandaloneMode) {
                await this.loadReaderHome();
            }
            return true;
        } catch (e) {
            const message = e.message || String(e);
            if (message !== t('common.profileLoginCancelled'))
                this.$root.stdDialog.alert(message, this.uiText.error);
            return false;
        }
    }

    async handleReaderProfileChipClick() {
        if (this.readerProfileCanLogin)
            await this.promptReaderProfileLogin();
    }

    async ensureReaderProfileReady() {
        if (!this.readerProfileWarningVisible)
            return true;

        if (this.readerProfileCanLogin)
            return await this.promptReaderProfileLogin();

        return false;
    }
}
