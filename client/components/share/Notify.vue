<template>
    <div class="hidden"></div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../vueComponent.js';
import {tm} from '../../share/i18n';
const {escapeHtml} = require('../../../shared/safeHtml');

class Notify {
    notify(opts) {
        let {
            caption = null,
            captionColor = 'black',
            color = 'positive',
            icon = '',
            iconColor = 'white',
            message = '',
            messageColor = 'black',
            position = 'top-right',
            html = false,
            actions = [],//кнопки Quasar ({label, handler}) перед кнопкой закрытия
            timeout,//0 - пока не закроют
        } = opts;

        //сообщения - текст (имена, названия книг); разметка только с opts.html
        message = tm(message);
        if (!html) {
            message = escapeHtml(message);
            caption = (caption ? escapeHtml(caption) : caption);
        }
        caption = (caption ? `<div style="font-size: 120%; color: ${captionColor}"><b>${caption}</b></div><br>` : '');
        return this.$q.notify({
            position,
            color,
            textColor: iconColor,
            icon,
            actions: [...actions, {icon: 'la la-times notify-button-icon', color: 'black'}],
            ...(timeout === undefined ? {} : {timeout}),
            html: true,

            message: 
                `<div style="max-width: 350px;">
                    ${caption}
                    <div style="color: ${messageColor}; overflow-wrap: break-word; word-wrap: break-word;">${message}</div>
                </div>`
        });
    }

    success(message, caption, options) {
        this.notify(Object.assign({color: 'positive', icon: 'la la-check-circle', message, caption}, options));
    }

    warning(message, caption, options) {
        this.notify(Object.assign({color: 'warning', icon: 'la la-exclamation-circle', message, caption}, options));
    }

    error(message, caption, options) {
        this.notify(Object.assign({color: 'negative', icon: 'la la-exclamation-circle', messageColor: 'yellow', captionColor: 'white', message, caption}, options));
    }

    //возвращает функцию, закрывающую уведомление
    info(message, caption, options) {
        return this.notify(Object.assign({color: 'info', icon: 'la la-bell', message, caption}, options));
    }
}

export default vueComponent(Notify);
//-----------------------------------------------------------------------------
</script>
