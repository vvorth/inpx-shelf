const path = require('path');
const webpack = require('webpack');
const pckg = require('../package.json');

const { merge } = require('webpack-merge');
const baseWpConfig = require('./webpack.base.config');
const appdir = require('./appdir');

baseWpConfig.entry.unshift('webpack-hot-middleware/client');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const publicDir = path.resolve(__dirname, `../server/.${pckg.name}/public`);
const clientDir = path.resolve(__dirname, '../client');
const buildId = `dev-${Date.now()}`;

module.exports = merge(baseWpConfig, {
    mode: 'development',
    devtool: 'inline-source-map',
    output: {
        path: `${publicDir}${baseWpConfig.output.publicPath}`,
        filename: 'bundle.js',
    },

    module: {
        rules: [
            {
                test: /\.css$/,
                use: [
                  'vue-style-loader',
                  'css-loader'
                ]
            },
        ]
    },

    plugins: [
        new webpack.DefinePlugin({
            __INPX_WEB_BUILD_ID__: JSON.stringify(buildId),
        }),
        new webpack.HotModuleReplacementPlugin(),
        new webpack.NoEmitOnErrorsPlugin(),
        new HtmlWebpackPlugin({
            template: `${clientDir}/index.html.template`,
            filename: `${publicDir}/index.html`
        }),
        new CopyWebpackPlugin({
            patterns: [
                {
                    context: `${clientDir}/assets`,
                    from: '**/*',
                    to: `${publicDir}/`,
                    noErrorOnMissing: true,
                    transform(content, absoluteFrom) {
                        if (!['sw.js', 'build-id.txt'].includes(path.basename(absoluteFrom)))
                            return content;

                        return content.toString('utf8').replace(/__INPX_WEB_BUILD_ID__/g, buildId)
                            .replace(/__INPX_WEB_APP_DIR__/g, appdir);
                    },
                },
            ],
        })
    ]
});
