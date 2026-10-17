// initial state
const state = {
    config: {},
    settings: {
        currentUserId: '',
        profileAccessToken: '',

        //uiDefaults
        limit: 20,
        downloadAsZip: false,
        bookView: 'cards',
        showDeleted: false,
        langDefault: '',
        showNewReleaseAvailable: true,
        darkTheme: false,
        isoDates: true,
        uiLang: '',
        showDiscoveryContinueReading: true,
        showDiscoveryFromLists: true,
        showDiscoveryUnfinishedSeries: true,
        showDiscoveryExternal: true,
        showDiscoverySimilar: true,
        showDiscoveryUnreadOnly: false,
        listsView: 'table',
        listsSort: '',
        discoveryExternalLimit: 24,
        discoveryExternalSource: '',
        discoveryExternalName: '',
        discoveryExternalTtlMinutes: 1440,
        discoveryExternalGenreUrl: '',
    },    
};

// getters
const getters = {};

// actions
const actions = {};

// mutations
const mutations = {
    setConfig(state, value) {
        state.config = value;
    },
    setSettings(state, value) {
        state.settings = Object.assign({}, state.settings, value);
    },
};

export default {
    namespaced: true,
    state,
    getters,
    actions,
    mutations
};
