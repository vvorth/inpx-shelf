
function utilsHasProp(obj, prop) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, prop);
}

// Discovery shelves: taste, events, metrics and the shared external source. Mixed into ReadingListStore.prototype: `this` is the store.
module.exports = {
    normalizeDiscoveryMetrics(value = {}) {
        const validMetricKeys = [
            'impression',
            'open',
            'start',
            'save',
            'download',
        ];
        const normalizeCounts = (row = {}) => Object.fromEntries(
            validMetricKeys.map(key => [key, Math.max(0, Math.min(1000000000, parseInt(row && row[key], 10) || 0))])
        );
        const shelves = Object.fromEntries(
            Object.entries(value.shelves && typeof(value.shelves) === 'object' ? value.shelves : {})
                .map(([shelfId, row]) => {
                    const id = String(shelfId || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80);
                    if (!id)
                        return null;
                    return [id, Object.assign(normalizeCounts(row), {
                        lastEventAt: String(row && row.lastEventAt || '').trim(),
                    })];
                })
                .filter(Boolean)
                .sort((a, b) => String(a[1].lastEventAt || '').localeCompare(String(b[1].lastEventAt || '')))
                .slice(-100)
        );

        return {
            totals: normalizeCounts(value.totals),
            shelves,
        };
    },

    normalizeDiscoveryPreferences(value = {}) {
        const events = Object.fromEntries(
            Object.entries(value.events && typeof(value.events) === 'object' ? value.events : {})
                .map(([bookUid, row]) => {
                    const normalizedBookUid = this.normalizeBookUid(bookUid);
                    if (!normalizedBookUid || !row || typeof(row) !== 'object')
                        return null;
                    const normalizeCount = count => Math.max(0, Math.min(10000, parseInt(count, 10) || 0));
                    return [normalizedBookUid, {
                        impressionCount: normalizeCount(row.impressionCount),
                        openCount: normalizeCount(row.openCount),
                        startCount: normalizeCount(row.startCount),
                        lastShownAt: String(row.lastShownAt || '').trim(),
                        lastOpenedAt: String(row.lastOpenedAt || '').trim(),
                        lastStartedAt: String(row.lastStartedAt || '').trim(),
                        lastEventAt: String(row.lastEventAt || '').trim(),
                    }];
                })
                .filter(Boolean)
                .sort((a, b) => String(a[1].lastEventAt || '').localeCompare(String(b[1].lastEventAt || '')))
                .slice(-5000)
        );
        const normalizeTasteList = (items, maxItems, maxLength) => Array.from(new Set(
            (Array.isArray(items) ? items : [])
                .map(item => String(item || '').replace(/\s+/g, ' ').trim())
                .filter(item => item && item.length <= maxLength)
        )).slice(0, maxItems);
        const tasteValue = (value.taste && typeof(value.taste) === 'object' ? value.taste : {});
        const taste = {
            genres: normalizeTasteList(tasteValue.genres, 20, 80).map(item => item.toLowerCase()),
            authors: normalizeTasteList(tasteValue.authors, 20, 160),
            languages: normalizeTasteList(tasteValue.languages, 10, 20).map(item => item.toLowerCase()),
            explorationRatio: Math.max(0.1, Math.min(0.3, Number(tasteValue.explorationRatio) || 0.15)),
            completedAt: String(tasteValue.completedAt || '').trim(),
            promptDismissedAt: String(tasteValue.promptDismissedAt || '').trim(),
            updatedAt: String(tasteValue.updatedAt || '').trim(),
        };

        return {
            events,
            taste,
            metrics: this.normalizeDiscoveryMetrics(value.metrics),
        };
    },

    normalizeSharedDiscoveryConfig(value = {}) {
        const sourceValue = String(value.externalSource || 'none').trim().toLowerCase();
        return {
            externalSource: (sourceValue && sourceValue !== 'none' ? 'wikidata-awards' : 'none'),
            externalName: String(value.externalName || '').trim(),
            externalTtlMinutes: Math.max(1440, Math.min(parseInt(value.externalTtlMinutes, 10) || 1440, 10080)),
        };
    },

    async getSharedDiscoveryConfig() {
        const data = await this.load();
        return this.normalizeSharedDiscoveryConfig(data.sharedDiscoveryConfig);
    },

    async updateSharedDiscoveryConfig(patch = {}) {
        const data = await this.load();
        data.sharedDiscoveryConfig = this.normalizeSharedDiscoveryConfig(Object.assign({}, data.sharedDiscoveryConfig || {}, patch || {}));
        await this.save(data);
        return data.sharedDiscoveryConfig;
    },

    async updateDiscoveryPreferences(userId = '', patch = {}) {
        const {data, user: target} = await this.resolveUser(userId);

        const current = this.normalizeDiscoveryPreferences(target.discoveryPreferences);
        const events = Object.assign({}, current.events || {});
        const metrics = this.normalizeDiscoveryMetrics(current.metrics);
        let taste = Object.assign({}, current.taste || {});

        if (utilsHasProp(patch, 'taste')) {
            taste = this.normalizeDiscoveryPreferences({
                taste: Object.assign({}, taste, patch.taste || {}, {
                    completedAt: String(patch.taste && patch.taste.completedAt || taste.completedAt || this.nowIso()),
                    updatedAt: this.nowIso(),
                }),
            }).taste;
        }

        if (utilsHasProp(patch, 'tastePromptDismissedAt')) {
            taste = this.normalizeDiscoveryPreferences({
                taste: Object.assign({}, taste, {
                    promptDismissedAt: String(patch.tastePromptDismissedAt || this.nowIso()),
                }),
            }).taste;
        }

        target.discoveryPreferences = this.normalizeDiscoveryPreferences({events, taste, metrics});
        target.updatedAt = this.nowIso();
        await this.save(data);
        return target.discoveryPreferences;
    },

    async recordDiscoveryEvents(userId = '', inputEvents = []) {
        const {data, user: target} = await this.resolveUser(userId);

        const preferences = this.normalizeDiscoveryPreferences(target.discoveryPreferences);
        const events = Object.assign({}, preferences.events || {});
        const metrics = this.normalizeDiscoveryMetrics(preferences.metrics);
        const validTypes = new Set(['impression', 'open', 'start', 'save', 'download']);
        const seen = new Set();
        let recorded = 0;

        for (const item of (Array.isArray(inputEvents) ? inputEvents.slice(0, 200) : [])) {
            const bookUid = this.normalizeBookUid(item && (item.bookUid || item._uid));
            const type = String(item && item.type || '').trim().toLowerCase();
            const shelfId = String(item && item.shelfId || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80) || 'unknown';
            const eventKey = `${bookUid}:${type}:${shelfId}`;
            if (!bookUid || !validTypes.has(type) || seen.has(eventKey))
                continue;
            seen.add(eventKey);

            const now = this.nowIso();
            const row = Object.assign({
                impressionCount: 0,
                openCount: 0,
                startCount: 0,
                lastShownAt: '',
                lastOpenedAt: '',
                lastStartedAt: '',
                lastEventAt: '',
            }, events[bookUid] || {});
            if (type === 'impression') {
                row.impressionCount = Math.min(10000, row.impressionCount + 1);
                row.lastShownAt = now;
            } else if (type === 'open' || type === 'save') {
                row.openCount = Math.min(10000, row.openCount + 1);
                row.lastOpenedAt = now;
            } else if (type === 'start' || type === 'download') {
                row.startCount = Math.min(10000, row.startCount + 1);
                row.lastStartedAt = now;
            }
            row.lastEventAt = now;
            events[bookUid] = row;
            metrics.totals[type] = Math.min(1000000000, (metrics.totals[type] || 0) + 1);
            const shelf = Object.assign({}, metrics.shelves[shelfId] || {});
            shelf[type] = Math.min(1000000000, (shelf[type] || 0) + 1);
            shelf.lastEventAt = now;
            metrics.shelves[shelfId] = shelf;
            recorded++;
        }

        if (!recorded)
            return {recorded: 0};

        target.discoveryPreferences = this.normalizeDiscoveryPreferences({
            events,
            taste: preferences.taste,
            metrics,
        });
        target.updatedAt = this.nowIso();
        await this.save(data);
        return {recorded};
    },

    async getDiscoveryMetrics() {
        const data = await this.load();
        const result = this.normalizeDiscoveryMetrics();
        let profiles = 0;
        let configuredProfiles = 0;

        for (const user of (Array.isArray(data.users) ? data.users : [])) {
            const preferences = this.normalizeDiscoveryPreferences(user && user.discoveryPreferences);
            const metrics = preferences.metrics;
            const hasSignals = Object.values(metrics.totals).some(value => Number(value) > 0);
            if (hasSignals)
                profiles++;
            if (preferences.taste.completedAt || preferences.taste.genres.length || preferences.taste.authors.length || preferences.taste.languages.length)
                configuredProfiles++;

            for (const [key, value] of Object.entries(metrics.totals))
                result.totals[key] = Math.min(1000000000, (result.totals[key] || 0) + (Number(value) || 0));
            for (const [shelfId, row] of Object.entries(metrics.shelves)) {
                const target = Object.assign({}, result.shelves[shelfId] || {});
                for (const [key, value] of Object.entries(row)) {
                    if (key === 'lastEventAt') {
                        if (String(value || '').localeCompare(String(target.lastEventAt || '')) > 0)
                            target.lastEventAt = String(value || '');
                    } else {
                        target[key] = Math.min(1000000000, (target[key] || 0) + (Number(value) || 0));
                    }
                }
                result.shelves[shelfId] = target;
            }
        }

        const impressions = Math.max(0, Number(result.totals.impression) || 0);
        const rate = value => (impressions ? Number(((Number(value) || 0) / impressions).toFixed(4)) : 0);
        return Object.assign(result, {
            profiles,
            configuredProfiles,
            rates: {
                ctr: rate(result.totals.open),
                start: rate(result.totals.start),
                save: rate(result.totals.save),
            },
        });
    },
};
