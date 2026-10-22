const js = require('@eslint/js');
const pluginVue = require('eslint-plugin-vue');
const globals = require('globals');

//глобальные функции логгера (server/core/AppLogger.js)
const logGlobals = Object.fromEntries(['LM_OK', 'LM_INFO', 'LM_WARN', 'LM_ERR', 'LM_FATAL', 'LM_TOTAL'].map(name => [name, 'readonly']));

module.exports = [
    //скрытые файлы и каталоги, в том числе dev-сборка клиента в server/.inpx-shelf/public
    {ignores: ['**/.*']},

    js.configs.recommended,
    ...pluginVue.configs['flat/recommended'],

    {
        files: ['**/*.js', '**/*.vue'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {...globals.node, ...logGlobals},
        },
        rules: {
            'vue/html-indent': ['warn', 4, {alignAttributesVertically: false}],
            'vue/max-attributes-per-line': 'off',
            'vue/html-self-closing': 'off',
            'vue/no-v-html': 'off',

            //recommended из eslint 8: с тех пор правила убраны из набора или изменили умолчания
            'no-unused-vars': ['error', {caughtErrors: 'none'}],
            'no-extra-semi': 'error',
            'no-mixed-spaces-and-tabs': 'error',
            'no-inner-declarations': 'error',
            'no-useless-assignment': 'off',
            'preserve-caught-error': 'off',

            'space-before-function-paren': ['error', 'never'],
            'max-len': ['warn', 200, 4, {ignoreComments: true, ignoreUrls: true}],
        },
    },

    //клиент - ES-модули для webpack
    {
        files: ['client/**/*.js', 'client/**/*.vue'],
        languageOptions: {sourceType: 'module'},
    },
    //браузерные имена - для клиента и shared/ (shared/ подключается и сервером, и клиентом)
    {
        files: ['client/**/*.js', 'client/**/*.vue', 'shared/**/*.js'],
        languageOptions: {globals: globals.browser},
    },
];
