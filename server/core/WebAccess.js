const StateStore = require('./StateStore');
const utils = require('../core/utils');
const log = new (require('../core/AppLogger'))().log;//singleton
const asyncExit = new (require('./AsyncExit'))();

const cleanPeriod = 1*60*1000;//1 минута
const cleanUnusedTokenTimeout = 5*60*1000;//5 минут
//соль выдаётся на каждый запрос без пароля: столько неиспользованных храним, самые старые уходят
const maxUnusedTokens = 10000;

class WebAccess {
    constructor(config) {
        this.config = config;

        this.freeAccess = (config.accessPassword === '');
        this.accessTimeout = config.accessTimeout*60*1000;
        this.accessMap = new Map();

        asyncExit.add(this.closeDb.bind(this));

        setTimeout(() => { this.periodicClean(); }, cleanPeriod);
    }

    async init() {
        const store = new StateStore(this.config);

        //пароль сменился в конфиге - прежние сессии недействительны
        const pass = utils.getBufHash(this.config.accessPassword, 'sha256', 'hex');
        if (store.getSetting('accessPass') !== pass) {
            store.clearAccess();
            store.setSetting('accessPass', pass);
        }

        //загрузим токены сессий
        for (const row of store.getAccessRows())
            this.accessMap.set(row.id, row.value);

        this.db = store;
    }

    async closeDb() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    async periodicClean() {
        while (1) {//eslint-disable-line no-constant-condition
            try {
                const now = Date.now();

                //почистим accessMap
                if (!this.freeAccess) {
                    for (const [accessToken, accessRec] of this.accessMap) {
                        if (   !(accessRec.used > 0 || now - accessRec.time < cleanUnusedTokenTimeout)
                            || !(this.accessTimeout === 0 || now - accessRec.time < this.accessTimeout)
                            ) {
                            await this.deleteAccess(accessToken);
                        } else if (accessRec.used > 0 && !accessRec.saved) {
                            await this.saveAccess(accessToken);
                        }
                    }
                }

            } catch(e) {
                log(LM_ERR, `WebAccess.periodicClean error: ${e.message}`);
            }
            
            await utils.sleep(cleanPeriod);
        }
    }

    //число использований токена (1 - первый вход по паролю) или false; без пароля - true
    async hasAccess(accessToken) {
        if (this.freeAccess)
            return true;

        const accessRec = this.accessMap.get(accessToken);
        if (accessRec) {
            const now = Date.now();

            if (this.accessTimeout === 0 || now - accessRec.time < this.accessTimeout) {
                accessRec.used++;
                accessRec.time = now;
                accessRec.saved = false;
                if (accessRec.used === 1)
                    await this.saveAccess(accessToken);
                return accessRec.used;
            }
        }

        return false;
    }

    //книги и обложки по HTTP: токен, с которым уже вошли и сессия которого не истекла; счётчик не меняется
    hasTokenAccess(accessToken) {
        const accessRec = this.accessMap.get(accessToken);
        return !!(accessRec && accessRec.used > 0 && (this.accessTimeout === 0 || Date.now() - accessRec.time < this.accessTimeout));
    }

    //токен уже прошёл проверку пароля: запрос с ним - не попытка входа
    isActiveToken(accessToken) {
        const accessRec = this.accessMap.get(accessToken);
        return this.freeAccess || !!(accessRec && accessRec.used > 0);
    }

    async deleteAccess(accessToken) {
        this.db.deleteAccess(accessToken);
        this.accessMap.delete(accessToken);
    }

    async saveAccess(accessToken) {
        const value = this.accessMap.get(accessToken);
        if (!value || value.saved)
            return;

        value.saved = true;
        this.db.putAccess(accessToken, value);
    }

    newToken() {
        if (this.accessMap.size >= maxUnusedTokens) {
            for (const [token, rec] of this.accessMap) {
                if (!rec.used) {
                    this.accessMap.delete(token);
                    break;
                }
            }
        }
        const salt = utils.randomHexString(32);
        const accessToken = utils.getBufHash(this.config.accessPassword + salt, 'sha256', 'hex');
        this.accessMap.set(accessToken, {time: Date.now(), used: 0});

        return salt;
    }
}

module.exports = WebAccess;
module.exports.maxUnusedTokens = maxUnusedTokens;