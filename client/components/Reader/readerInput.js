//Управление читалкой: касания и клики по зонам страницы, свайпы, колесо мыши и клавиши, листание на страницу
//вперёд или назад в обоих режимах. Своего состояния нет: точка касания - поле Reader.

export default class ReaderInput {
    isReaderTapInteractiveTarget(target = null) {
        return !!(
            target
            && target.closest
            && target.closest('button, a, input, textarea, select, .q-btn, .reader-dialog')
        );
    }

    handleReaderTap(event) {
        if (
            Date.now() < (Number(this.suppressSyntheticReaderClickUntil || 0) || 0)
            && !this.isReaderTapInteractiveTarget(event && event.target)
        ) {
            if (event && event.cancelable)
                event.preventDefault();
            if (event && typeof event.stopPropagation === 'function')
                event.stopPropagation();
            return;
        }

        this.activateReaderTap(event);
    }

    activateReaderTap(event) {
        if (!event || !this.$refs.scroller)
            return;

        if (this.isCompactLayout && this.controlsOpen) {
            event.preventDefault();
            event.stopPropagation();
            this.toggleControls();
            return;
        }

        const target = event.target;
        const noteLink = this.getReaderInternalLink(target);
        if (noteLink) {
            const noteTarget = this.getReaderLinkTarget(noteLink);
            if (noteTarget) {
                event.preventDefault();
                event.stopPropagation();
                this.jumpToReaderAnchor(noteTarget, {
                    returnPoint: this.captureReaderNoteReturnPoint(),
                });
            }
            return;
        }

        if (this.isReaderTapInteractiveTarget(target))
            return;

        const selection = (window.getSelection ? window.getSelection().toString().trim() : '');
        if (selection)
            return;
        const consumeCompactTap = () => {
            if (this.isCompactLayout && event.cancelable)
                event.preventDefault();
        };

        const rect = this.$refs.scroller.getBoundingClientRect();
        const relX = (event.clientX - rect.left) / rect.width;
        const relY = (event.clientY - rect.top) / rect.height;
        if (this.isPagedMode) {
            const useHorizontalTapZones = this.isCompactLayout || this.isHorizontalPaged;
            if (useHorizontalTapZones) {
                if (relX <= 0.22) {
                    consumeCompactTap();
                    this.goToRelativePage(-1);
                    return;
                }
                if (relX >= 0.78) {
                    consumeCompactTap();
                    this.goToRelativePage(1);
                    return;
                }
            } else {
                if (relY <= 0.22) {
                    consumeCompactTap();
                    this.goToRelativePage(-1);
                    return;
                }
                if (relY >= 0.78) {
                    consumeCompactTap();
                    this.goToRelativePage(1);
                    return;
                }
            }
        }
        const isCenterTap = (relX >= 0.18 && relX <= 0.82 && relY >= 0.18 && relY <= 0.82);
        if (!isCenterTap)
            return;

        consumeCompactTap();
        this.toggleCompactChromeVisibility();
    }

    handleReaderWheel(event) {
        if (!this.isPagedMode || !this.$refs.scroller || !event)
            return;

        const delta = (this.isHorizontalPaged ? (Number(event.deltaX || 0) || Number(event.deltaY || 0)) : Number(event.deltaY || 0));
        if (Math.abs(delta) < 8)
            return;

        event.preventDefault();
        this.goToRelativePage(delta > 0 ? 1 : -1);
    }

    handleGlobalKeydown(event) {
        if (!event)
            return;

        const target = event.target;
        const tagName = String((target && target.tagName) || '').toLowerCase();
        const isTypingField = (
            (target && target.isContentEditable)
            || ['input', 'textarea', 'select'].includes(tagName)
            || (target && target.closest && target.closest('.q-dialog'))
        );
        if (isTypingField)
            return;

        if (!this.$route || this.$route.path !== (this.isStandaloneMode ? '/reader-lab' : '/reader'))
            return;

        const key = String(event.key || '');
        if (key === 'Escape') {
            if (this.searchDialogOpen) {
                event.preventDefault();
                this.searchDialogOpen = false;
                return;
            }
            if (this.helpDialogOpen) {
                event.preventDefault();
                this.helpDialogOpen = false;
                return;
            }
            if (this.contentsDialogOpen) {
                event.preventDefault();
                if (this.contentsPanelView === 'annotation')
                    this.showContentsList();
                else
                    this.closeContentsDialog();
                return;
            }
            if (this.bookmarksDialogOpen) {
                event.preventDefault();
                this.bookmarksDialogOpen = false;
                return;
            }
            if (this.controlsOpen) {
                event.preventDefault();
                this.toggleControls();
                return;
            }
            if (this.bookUid) {
                event.preventDefault();
                this.setReaderChromeHidden(!this.readerChromeHidden);// no await
                return;
            }
            return;
        }

        if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'f' && this.isPagedMode) {
            event.preventDefault();
            this.searchDialogOpen = true;
            return;
        }

        if (key === '?' && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            this.toggleHelpDialog();
            return;
        }

        if (this.helpDialogOpen)
            return;

        if (key === ' ' || key === 'Spacebar') {
            event.preventDefault();
            this.goToRelativePage(event.shiftKey ? -1 : 1);
            return;
        }

        if (!this.isPagedMode)
            return;

        const nextKeys = ['ArrowRight', 'ArrowDown', 'PageDown'];
        const prevKeys = ['ArrowLeft', 'ArrowUp', 'PageUp'];

        if (nextKeys.includes(key)) {
            event.preventDefault();
            this.goToRelativePage(1);
            return;
        }

        if (prevKeys.includes(key)) {
            event.preventDefault();
            this.goToRelativePage(-1);
        }
    }

    handleReaderTouchStart(event) {
        if ((!this.isCompactLayout && !this.isPagedMode) || !event || !event.touches || event.touches.length !== 1)
            return;

        const touch = event.touches[0];
        this.touchStartPoint = {
            x: Number(touch.clientX || 0) || 0,
            y: Number(touch.clientY || 0) || 0,
            startedAt: Date.now(),
        };
    }

    handleReaderTouchEnd(event) {
        if ((!this.isCompactLayout && !this.isPagedMode) || !this.touchStartPoint || !event || !event.changedTouches || !event.changedTouches.length)
            return;

        const touch = event.changedTouches[0];
        const deltaX = (Number(touch.clientX || 0) || 0) - this.touchStartPoint.x;
        const deltaY = (Number(touch.clientY || 0) || 0) - this.touchStartPoint.y;
        const touchDurationMs = Math.max(0, Date.now() - (Number(this.touchStartPoint.startedAt || 0) || Date.now()));
        this.touchStartPoint = null;

        const swipeThreshold = 36;
        const tapThreshold = (this.isCompactLayout && this.isPagedMode ? swipeThreshold : 12);
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        if (absX < tapThreshold && absY < tapThreshold) {
            if (!this.isCompactLayout || touchDurationMs > 420 || this.isReaderTapInteractiveTarget(event.target))
                return;

            const selection = (window.getSelection ? window.getSelection().toString().trim() : '');
            if (selection)
                return;

            if (event.cancelable)
                event.preventDefault();
            this.activateReaderTap({
                target: event.target,
                clientX: Number(touch.clientX || 0) || 0,
                clientY: Number(touch.clientY || 0) || 0,
                cancelable: false,
                preventDefault: () => {},
                stopPropagation: () => {
                    if (typeof event.stopPropagation === 'function')
                        event.stopPropagation();
                },
            });
            this.suppressSyntheticReaderClickUntil = Date.now() + 700;
            return;
        }

        if (!this.isPagedMode)
            return;
        if (absX < swipeThreshold && absY < swipeThreshold)
            return;

        if (absX >= absY) {
            this.goToRelativePage(deltaX < 0 ? 1 : -1);
            return;
        }

        this.goToRelativePage(deltaY < 0 ? 1 : -1);
    }

    handleReaderTouchCancel() {
        this.touchStartPoint = null;
    }

    goToRelativePage(delta = 0) {
        if (!this.$refs.scroller)
            return;

        const scroller = this.$refs.scroller;
        if (this.isPagedMode) {
            const nextIndex = this.currentPagedPageIndex + (delta * this.pagedStep);
            this.setCurrentPagedPage(nextIndex, true);
            return;
        }

        //строки за видимой панелью не пропускаем
        const pageHeight = Math.max(1, scroller.clientHeight - (this.readerChromeHidden ? 0 : this.readerScrollTopInset));
        const nextTop = Math.max(0, Math.min(
            scroller.scrollHeight - scroller.clientHeight,
            scroller.scrollTop + delta * pageHeight,
        ));
        scroller.scrollTo({top: nextTop, behavior: 'smooth'});
    }
}
