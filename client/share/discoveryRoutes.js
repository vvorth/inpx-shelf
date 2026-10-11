//Внешняя витрина (лауреаты литературных премий из Викиданных) и её пункт в меню.
//Персональные подборки показываются на главной.
import {t} from './i18n';
import {isAdmin} from './session';

export const discoveryRouteOrder = ['bestsellers'];

export function externalDiscovery(config = {}, settings = {}) {
    const discovery = config.discovery || {};
    const own = isAdmin(config);
    const pick = (local, shared) => String(own ? (local || shared || '') : (shared || '')).trim();
    const source = pick(settings.discoveryExternalSource, discovery.externalSource).toLowerCase();
    return {
        source: (source && source !== 'none' ? 'wikidata-awards' : 'none'),
        name: pick(settings.discoveryExternalName, discovery.externalName),
    };
}

export function isDiscoveryRouteEnabled(route, config = {}, settings = {}) {
    const discoveryEnabled = ((config.discovery || {}).enabled !== false);
    if (!discoveryEnabled)
        return !discoveryRouteOrder.includes(route);

    if (route === 'bestsellers')
        return externalDiscovery(config, settings).source !== 'none' && settings.showDiscoveryExternal !== false;
    return true;
}

export function discoveryRouteLabel(route, config = {}, settings = {}) {
    if (route === 'bestsellers')
        return externalDiscovery(config, settings).name || t('common.externalSource');
    return route;
}

export function enabledDiscoveryRoutes(config = {}, settings = {}) {
    return discoveryRouteOrder.filter(route => isDiscoveryRouteEnabled(route, config, settings));
}
