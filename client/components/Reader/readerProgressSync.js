//Прогресс чтения со стороны компонента: позиция при открытии книги, сохранение в браузер и на сервер,
//сверка с другими устройствами (предложение перейти), отметка «прочитано» и её отмена.
//Правила выбора позиции - чистые функции readerProgress; своего состояния у слоя нет, поля живут в Reader.
import {t, formatDateTime} from '../../share/i18n';
const readerProgress = require('../../share/readerProgress');
const readerStorage = require('../../share/readerStorage');

export default class ReaderProgressSync {
    get progressPercent() {
        return Math.round((Number(this.progress.percent || 0) || 0) * 100);
    }

    get isBookMarkedRead() {
        return this.progressPercent >= 100;
    }

    get hasSavedProgress() {
        return this.hasReaderProgressPlace(this.progress || {});
    }

    //Позиция при открытии книги; с другого устройства новее и далеко - offeredRemoteProgress, loadReader спросит
    applyOpeningProgress(stateResponse = {}) {
        const storedProgress = this.readStoredReaderProgress();
        const opening = readerProgress.opening(stateResponse, this.getCurrentProfileBookProgress(), storedProgress);
        this.readerProgressGeneration = opening.generation;
        if (opening.dropStored)
            this.clearStoredReaderProgress(this.bookUid);
        this.offeredRemoteProgress = opening.remote;
        this.progress = opening.progress;
        this.pendingReaderProgressUpload = opening.upload;
    }

    getCurrentProfileBookProgress() {
        if (!this.bookUid)
            return null;

        const current = this.config.currentUserProfile || {};
        const items = Array.isArray(current.currentReading) ? current.currentReading : [];
        const item = items.find((row) => String(row.bookUid || '').trim() === this.bookUid);
        if (!item)
            return null;

        return {
            percent: Number(item.percent || 0) || 0,
            sectionId: String(item.sectionId || '').trim(),
            pageIndex: Number(item.pageIndex || 0) || 0,
            updatedAt: String(item.updatedAt || '').trim(),
        };
    }

    jumpToProgress() {
        this.clearPendingReaderNavigationRestore({clearNoteReturn: true});
        this.bookmarksDialogOpen = false;
        this.restorePending = true;
        this.$nextTick(() => {
            requestAnimationFrame(() => this.restoreProgress());
        });
    }

    handleReaderProgressGenerationResponse(rawResponseProgress = {}) {
        if (!rawResponseProgress || typeof rawResponseProgress !== 'object')
            return false;

        const responseGeneration = Number(rawResponseProgress.generation);
        if (Number.isFinite(responseGeneration))
            this.readerProgressGeneration = Math.max(0, Math.round(responseGeneration));

        if (rawResponseProgress.reset !== true && rawResponseProgress.generationMismatch !== true)
            return false;

        if (rawResponseProgress.reset === true) {
            this.progress = this.normalizeReaderProgress({
                generation: this.readerProgressGeneration,
            });
            this.currentSectionId = '';
            this.clearStoredReaderProgress(this.bookUid);
            return true;
        }

        this.progress = this.normalizeReaderProgress(rawResponseProgress);
        this.currentSectionId = String(this.progress.sectionId || '').trim();
        this.writeStoredReaderProgress(this.progress);
        return true;
    }

    async persistProgress(bookUid = this.bookUid) {
        if (!bookUid)
            return;
        if (
            this.isPagedMode
            && (this.restorePending || this.pagedBuildInProgress || !this.pagedPages.length)
        ) {
            if (this.pagedBuildInProgress && this.pagedPages.length)
                this.progressPersistPendingAfterPagedBuild = true;
            return;
        }

        const requestProgress = this.normalizeReaderProgress(Object.assign({}, this.progress, {
            sectionId: this.currentSectionId || this.progress.sectionId || '',
        }));
        this.writeStoredReaderProgress(requestProgress, bookUid);

        if (this.readerProfileWarningVisible && !this.readerProfileAuthorized)
            return;

        const api = this.$root.api;
        if (!api)
            return;

        const progressPatch = {
            percent: requestProgress.percent,
            sectionId: requestProgress.sectionId,
            pageIndex: requestProgress.pageIndex,
            textOffset: requestProgress.textOffset,
            textSnippet: requestProgress.textSnippet,
            updatedAt: requestProgress.updatedAt,
            generation: this.readerProgressGeneration,
        };
        let response = await api.updateReaderProgress(bookUid, progressPatch, {suppressProfileLogin: true});
        if (bookUid !== this.bookUid)
            return;
        let rawResponseProgress = (response && response.progress ? response.progress : {});
        const responseGeneration = Number(rawResponseProgress && rawResponseProgress.generation);
        if (Number.isFinite(responseGeneration)) {
            this.readerProgressGeneration = Math.max(0, Math.round(responseGeneration));
            progressPatch.generation = this.readerProgressGeneration;
        }
        if (this.handleReaderProgressGenerationResponse(rawResponseProgress))
            return;

        const currentProgress = this.normalizeReaderProgress(this.progress);
        const requestTime = Date.parse(requestProgress.updatedAt || '');
        const currentTime = Date.parse(currentProgress.updatedAt || '');
        if (
            Number.isFinite(requestTime)
            && Number.isFinite(currentTime)
            && currentTime > requestTime
        ) {
            this.writeStoredReaderProgress(currentProgress);
            return;
        }

        if (!readerProgress.samePosition(rawResponseProgress, requestProgress)) {
            response = await api.updateReaderProgress(bookUid, Object.assign({}, progressPatch, {force: true}), {suppressProfileLogin: true});
            if (bookUid !== this.bookUid)
                return;
            rawResponseProgress = (response && response.progress ? response.progress : {});
            const forcedGeneration = Number(rawResponseProgress && rawResponseProgress.generation);
            if (Number.isFinite(forcedGeneration))
                this.readerProgressGeneration = Math.max(0, Math.round(forcedGeneration));
            if (this.handleReaderProgressGenerationResponse(rawResponseProgress))
                return;
        }

        const savedProgress = this.mergeReaderProgress(this.progress, response && response.progress ? response.progress : {});
        this.progress = Object.assign({}, this.progress, savedProgress);
        this.currentSectionId = String(this.progress.sectionId || this.currentSectionId || '').trim();
        this.writeStoredReaderProgress();
    }

    queuePersistProgress(bookUid = this.bookUid) {
        const request = this.persistProgress(bookUid)
            .catch(() => {})
            .finally(() => {
                if (this.progressSavePromise === request)
                    this.progressSavePromise = null;
            });
        this.progressSavePromise = request;
        return request;
    }

    //Вкладка снова видна: позиция могла уйти вперёд на другом устройстве
    async checkRemoteProgress() {
        const api = this.$root.api;
        const bookUid = this.bookUid;
        if (!api || !bookUid || this.isStandaloneMode || this.loading || this.bookPreparing || this.error)
            return;
        if (this.readerProfileWarningVisible && !this.readerProfileAuthorized)
            return;

        let state = null;
        try {
            state = await api.getReaderState(bookUid, {suppressProfileLogin: true});
        } catch (e) {
            return;
        }
        if (bookUid !== this.bookUid || this.loading || this.bookPreparing || !state)
            return;

        // Сброс прогресса на другом устройстве обработает сохранение (handleReaderProgressGenerationResponse)
        const generation = Math.max(0, parseInt(state.progressGeneration, 10) || 0);
        const remote = this.readerProgressAfterReset(state.progress, state.progressResetAt, generation);
        if (!remote || generation !== this.readerProgressGeneration)
            return;

        // Время своей позиции - последнее сохранение: перестройка страниц обновляет updatedAt без чтения
        const stored = this.readStoredReaderProgress();
        const local = Object.assign({}, this.progress, {
            sectionId: this.currentSectionId || this.progress.sectionId || '',
            updatedAt: (stored && stored.updatedAt) || this.progress.updatedAt,
        });
        const choice = readerProgress.chooseRemote(local, remote, {generation});
        if (choice.remote)
            this.offerRemoteProgress(choice.remote);
        else if (!this.hasReaderProgressPlace(local) && !readerProgress.samePosition(choice.progress, local))
            this.goToRemoteProgress(bookUid, choice.progress);
    }

    offerRemoteProgress(remote = {}) {
        this.dismissRemoteProgressOffer();
        const bookUid = this.bookUid;
        const section = this.contents.find(item => item.id === remote.sectionId);
        const details = [section ? section.title : '', formatDateTime(remote.updatedAt)].filter(Boolean).join(', ');
        this.offeredRemoteProgress = remote;
        this.dismissRemoteProgressNotify = this.$root.notify.info(
            t('reader.remoteProgress', {percent: Math.round((Number(remote.percent) || 0) * 100), details}),
            '',
            Object.assign({}, this.readerNotifyOptions, {
                icon: 'la la-sync',
                timeout: 0,
                actions: [
                    {label: t('reader.remoteProgressGo'), color: 'primary', handler: () => this.goToRemoteProgress(bookUid, remote)},
                    {label: t('reader.remoteProgressStay'), color: 'primary', handler: () => this.keepLocalProgress(bookUid)},
                ],
            }),
        );
    }

    dismissRemoteProgressOffer() {
        if (this.dismissRemoteProgressNotify)
            this.dismissRemoteProgressNotify();
        this.dismissRemoteProgressNotify = null;
        this.offeredRemoteProgress = null;
    }

    goToRemoteProgress(bookUid = '', remote = {}) {
        this.dismissRemoteProgressOffer();
        if (bookUid !== this.bookUid)
            return;

        this.progress = this.normalizeReaderProgress(remote);
        this.currentSectionId = this.progress.sectionId;
        this.writeStoredReaderProgress();
        this.jumpToProgress();
    }

    //Остаться здесь: своя позиция становится самой новой, чтобы вопрос не вернулся при следующей сверке
    keepLocalProgress(bookUid = '') {
        this.dismissRemoteProgressOffer();
        if (bookUid !== this.bookUid)
            return;

        this.progress = Object.assign({}, this.progress, {updatedAt: new Date().toISOString()});
        this.writeStoredReaderProgress();
        this.queuePersistProgress(bookUid);// no await
    }

    async toggleCurrentBookRead() {
        await this.setCurrentBookRead(!this.isBookMarkedRead);
    }

    //Доля прочитанного по тому, что сейчас на экране: место, где читатель был до отметки «прочитано»
    currentViewPercent() {
        if (this.isPagedMode)
            return (this.pagedProgressTotalPages > 1 ? this.currentPagedPageIndex / (this.pagedProgressTotalPages - 1) : 0);

        const scroller = this.$refs.scroller;
        const maxScroll = (scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0);
        return (maxScroll > 0 ? scroller.scrollTop / maxScroll : 0);
    }

    async setCurrentBookRead(read = true, {undoable = true} = {}) {
        if (!this.bookUid)
            return;

        if (!await this.ensureReaderProfileReady())
            return;

        const api = this.$root.api;
        if (!api)
            return;

        const bookUid = this.bookUid;
        try {
            // Сервер при отметке стирает место в книге, при снятии - весь прогресс: место сохраняем следом
            await api.setBookRead(bookUid, read);
            if (bookUid !== this.bookUid)
                return;

            const place = Object.assign({}, this.progress, {sectionId: this.currentSectionId || this.progress.sectionId || ''});
            const updatedAt = new Date().toISOString();
            this.progress = (read
                ? readerProgress.markRead(place, updatedAt, this.readerProgressGeneration)
                : readerProgress.unmarkRead(place, this.currentViewPercent(), updatedAt, this.readerProgressGeneration));
            this.currentSectionId = this.progress.sectionId;
            this.restoredScrollTop = ((!this.isPagedMode && this.$refs.scroller) ? this.$refs.scroller.scrollTop : -1);
            if (this.hasReaderProgressPlace(this.progress)) {
                this.writeStoredReaderProgress();
                this.queuePersistProgress(bookUid);// no await
            } else {
                this.clearStoredReaderProgress(bookUid);
            }

            const actions = (undoable
                ? [{label: this.uiText.undo, color: 'primary', handler: () => this.setCurrentBookRead(!read, {undoable: false})}]
                : []);
            this.$root.notify.success(read ? this.uiText.readMarked : this.uiText.readUnmarked, '', Object.assign({actions}, this.readerNotifyOptions));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.error);
        }
    }

    readStoredReaderProgress() {
        return readerStorage.readProgress(String(this.currentUserId || '').trim(), this.bookUid);
    }

    readerProgressAfterReset(progress = null, resetAt = '', generation = 0) {
        return readerProgress.afterReset(progress, resetAt, generation);
    }

    clearStoredReaderProgress(bookUid = '', options = {}) {
        readerStorage.clearProgress(String(this.currentUserId || '').trim(), bookUid, options);
    }

    writeStoredReaderProgress(progress = null, bookUid = this.bookUid) {
        readerStorage.writeProgress(String(this.currentUserId || '').trim(), bookUid, progress || this.progress, {
            protectForward: !!(
                this.isPagedMode
                && (this.loading || this.bookPreparing || this.restorePending || this.pagedBuildInProgress || !this.pagedPages.length)
            ),
            generation: this.readerProgressGeneration,
        });
    }

    normalizeReaderProgress(progress = {}) {
        return readerProgress.normalize(progress, this.readerProgressGeneration);
    }

    mergeReaderProgress(primary = {}, secondary = {}, options = {}) {
        return readerProgress.merge(primary, secondary, Object.assign({generation: this.readerProgressGeneration}, options));
    }

    shouldUploadRestoredReaderProgress(serverProgress = {}, restoredProgress = {}) {
        return readerProgress.shouldUpload(serverProgress, restoredProgress);
    }

    hasReaderProgressPlace(progress = {}) {
        return readerProgress.hasPlace(progress);
    }

    flushProgress() {
        if (this.saveProgressDebounced && this.saveProgressDebounced.flush)
            this.saveProgressDebounced.flush();
        else
            this.queuePersistProgress();

        return this.progressSavePromise;
    }
}
