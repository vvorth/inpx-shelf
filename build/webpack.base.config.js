const path = require('path');
const DefinePlugin = require('webpack').DefinePlugin;
const { VueLoaderPlugin } = require('vue-loader');

const appdir = require('./appdir');

const clientDir = path.resolve(__dirname, '../client');

module.exports = {
    entry: [`${clientDir}/main.js`],
    output: {
        publicPath: `/${appdir}/`,
        clean: true
    },

    module: {
        rules: [
            {
                test: /\.vue$/,
                loader: 'vue-loader',
            },
            {
                test: /\.js$/,
                loader: 'babel-loader',
                exclude: /node_modules/,
                //настройки babel в .babelrc
            },
            {
                //до css-loader: из стилей Quasar и Line Awesome убирается неиспользуемое
                test: /[\\/](quasar|line-awesome)\.css$/,
                enforce: 'pre',
                loader: path.resolve(__dirname, 'css-subset-loader.js'),
            },
            {
                test: /\.(gif|png)$/,
                type: 'asset/inline',
            },
            {
                test: /\.jpg$/,
                type: 'asset/resource',
                generator: {
                    filename: 'images/[name]-[hash:6][ext]'
                },
            },

            {
                test: /\.(ttf|eot|woff|woff2)$/,
                type: 'asset/resource',
                generator: {
                    filename: 'fonts/[name].[contenthash][ext]'
                },
            },
        ]
    },

    plugins: [
        new DefinePlugin({
            __VUE_OPTIONS_API__: true,
            __VUE_PROD_DEVTOOLS__: false,
            __QUASAR_SSR__: false,
            __QUASAR_SSR_SERVER__: false,
            __QUASAR_SSR_CLIENT__: false,
            __QUASAR_VERSION__: false,
        }),
        new VueLoaderPlugin(),
    ]
};
