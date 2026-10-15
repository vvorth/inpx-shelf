import { reactive } from 'vue';

//Новая сборка приложения на сервере: main.js отмечает её, оболочка предлагает перезагрузить страницу.
//reload - перезагрузка в новую версию (задаёт main.js), dismissed - читатель скрыл предложение
export const appUpdate = reactive({available: false, dismissed: false, reload: null});
