<template>
    <div class="user-menu">
        <template v-if="signedIn">
            <router-link v-close-popup class="user-menu-item" to="/me/account">
                <q-icon name="la la-user" size="18px" />{{ $t('Аккаунт') }}
            </router-link>
            <router-link v-close-popup class="user-menu-item" to="/me/devices">
                <q-icon name="la la-tablet" size="18px" />{{ $t('Устройства: OPDS и Kobo') }}
            </router-link>
            <router-link v-close-popup class="user-menu-item" to="/me/preferences">
                <q-icon name="la la-sliders-h" size="18px" />{{ $t('Настройки интерфейса') }}
            </router-link>
            <router-link v-if="admin" v-close-popup class="user-menu-item" to="/admin">
                <q-icon name="la la-shield-alt" size="18px" />{{ $t('Администрирование') }}
            </router-link>
        </template>
        <router-link v-else v-close-popup class="user-menu-item" to="/me/preferences">
            <q-icon name="la la-sliders-h" size="18px" />{{ $t('Настройки интерфейса') }}
        </router-link>

        <button v-close-popup type="button" class="user-menu-item" @click="$emit('toggle-theme')">
            <q-icon :name="darkTheme ? 'la la-sun' : 'la la-moon'" size="18px" />{{ darkTheme ? $t('Светлая тема') : $t('Тёмная тема') }}
        </button>

        <div class="user-menu-sep" />

        <button v-if="!signedIn" v-close-popup type="button" class="user-menu-item" @click="$emit('sign-in')">
            <q-icon name="la la-sign-in-alt" size="18px" />{{ $t('Войти') }}
        </button>
        <button v-else-if="!sso" v-close-popup type="button" class="user-menu-item" @click="$emit('sign-out')">
            <q-icon name="la la-sign-out-alt" size="18px" />{{ $t('Выйти из профиля') }}
        </button>
        <button v-if="accessLocked" v-close-popup type="button" class="user-menu-item" @click="$emit('leave-library')">
            <q-icon name="la la-lock" size="18px" />{{ $t('Закрыть доступ к библиотеке') }}
        </button>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';

const componentOptions = {
    emits: ['sign-in', 'sign-out', 'leave-library', 'toggle-theme'],
};

class ShellUserMenu {
    _options = componentOptions;
    _props = {
        signedIn: Boolean,
        admin: Boolean,
        sso: Boolean,
        accessLocked: Boolean,
        darkTheme: Boolean,
    };
}

export default vueComponent(ShellUserMenu);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.user-menu {
    display: flex;
    flex-direction: column;
    min-width: 230px;
    padding: 6px 0;
}

.user-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border: 0;
    background: none;
    color: var(--app-text);
    text-decoration: none;
    text-align: left;
    font: inherit;
    cursor: pointer;
}

.user-menu-item:hover {
    background: var(--app-surface-3);
}

.user-menu-sep {
    height: 1px;
    margin: 6px 0;
    background: var(--app-border);
}
</style>
