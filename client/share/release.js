//Есть ли выпуск новее запущенной версии.
import release from '../../shared/release.js';

export function newReleaseAvailable(config = {}) {
    return !!(config.latestVersion && release.compareReleaseVersions(config.latestVersion, config.version) > 0);
}
