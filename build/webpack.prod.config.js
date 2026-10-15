const fs = require('fs-extra');
const path = require('path');
const webpack = require('webpack');

const { merge } = require('webpack-merge');
const baseWpConfig = require('./webpack.base.config');
const TerserPlugin = require('terser-webpack-plugin');
const CssMinimizerWebpackPlugin = require('css-minimizer-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const pckg = require('../package.json');

const publicDir = path.resolve(__dirname, '../dist/tmp/public');
const clientDir = path.resolve(__dirname, '../client');
const buildId = `${pckg.version}-${Date.now()}`;

fs.emptyDirSync(publicDir);

module.exports = merge(baseWpConfig, {
    mode: 'production',
    output: {
        path: `${publicDir}${baseWpConfig.output.publicPath}`,
        filename: 'bundle.[contenthash].js',
    },
    module: {
        rules: [
            {
                test: /\.css$/,
                use: [
                  MiniCssExtractPlugin.loader,
                  'css-loader'
                ]
            }
        ]
    },
    optimization: {
        //библиотеки стартовой страницы (Vue, Quasar, их CSS) - отдельным файлом: после обновления
        //приложения браузер берёт его из кэша, если библиотеки не менялись
        splitChunks: {
            cacheGroups: {
                vendor: {
                    test: /[\\/]node_modules[\\/]/,
                    name: 'vendor',
                    chunks: 'initial',
                },
            },
        },
        minimizer: [
            new TerserPlugin({
                parallel: true,
                terserOptions: {
                    format: {
                        comments: false,
                    },
                },
            }),
            new CssMinimizerWebpackPlugin()
        ]
    },
    plugins: [
        new webpack.DefinePlugin({
            __INPX_WEB_BUILD_ID__: JSON.stringify(buildId),
        }),
        new MiniCssExtractPlugin({
            filename: "[name].[contenthash].css"
        }),
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

                        return content.toString('utf8').replace(/__INPX_WEB_BUILD_ID__/g, buildId);
                    },
                },
            ],
        }),
    ]
});
