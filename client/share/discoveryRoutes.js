//Какие витрины (Для вас, Новинки, Популярное, внешний источник) сейчас доступны.
//Общая логика для меню приложения и для страницы каталога.
import {t} from './i18n';
import {isAdmin, needsLogin} from './session';

export const discoveryRouteOrder = ['for-you', 'newest', 'popular', 'bestsellers'];

export function externalDiscovery(config = {}, settings = {}) {
    const discovery = config.discovery || {};
    const own = isAdmin(config);
    const pick = (local, shared) => String(own ? (local || shared || '') : (shared || '')).trim();
    const source = pick(settings.discoveryExternalSource, discovery.externalSource).toLowerCase();
    return {
        source: (source && source !== 'none' ? 'web-page' : 'none'),
        name: pick(settings.discoveryExternalName, discovery.externalName),
        url: pick(settings.discoveryExternalUrl, discovery.externalUrl),
    };
}

export function isDiscoveryRouteEnabled(route, config = {}, settings = {}) {
    const discoveryEnabled = ((config.discovery || {}).enabled !== false);
    if (!discoveryEnabled)
        return !discoveryRouteOrder.includes(route);

    if (route === 'for-you') {
        const userId = String(settings.currentUserId || config.currentUserId || '').trim();
        return !!(userId && !needsLogin(config, settings));
    }
    if (route === 'newest')
        return settings.showDiscoveryNewest !== false;
    if (route === 'popular')
        return settings.showDiscoveryPopular !== false;
    if (route === 'bestsellers')
        return externalDiscovery(config, settings).source !== 'none' && settings.showDiscoveryExternal !== false;
    return true;
}

export function discoveryRouteLabel(route, config = {}, settings = {}) {
    if (route === 'for-you')
        return t('Для вас');
    if (route === 'newest')
        return t('Новинки');
    if (route === 'popular')
        return t('Популярное');
    if (route === 'bestsellers')
        return externalDiscovery(config, settings).name || t('Внешний источник');
    return route;
}

export function enabledDiscoveryRoutes(config = {}, settings = {}) {
    return discoveryRouteOrder.filter(route => isDiscoveryRouteEnabled(route, config, settings));
}
