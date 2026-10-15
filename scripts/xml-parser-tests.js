const assert = require('assert');
const XmlParser = require('../server/core/xml/XmlParser');
const sax = require('../server/core/xml/sax');

const parse = xml => new XmlParser().fromString(xml).toObject();

function testXmlParserTrickyInput() {
    //CDATA и комментарии не разбираются как теги
    assert.deepStrictEqual(parse('<a><![CDATA[<b>x</b> & ]]></a>'), {a: {'*CDATA': '<b>x</b> & '}});
    assert.deepStrictEqual(parse('<a><!-- c <b> --><b/></a>'), {a: {'*COMMENT': ' c <b> ', b: {}}});

    //сущности остаются как есть и не экранируются повторно при сериализации
    assert.deepStrictEqual(parse('<a>&amp;&lt;&#1025;</a>'), {a: {'*TEXT': '&amp;&lt;&#1025;'}});
    const xml = '<a x="1">&amp;<![CDATA[z]]></a>';
    assert.strictEqual(new XmlParser().fromString(xml).toString(), `<?xml version="1.0" encoding="utf-8"?>${xml}`);

    //значения объекта - обычный текст: экранируются один раз
    assert.strictEqual(new XmlParser().fromObject({a: {'*ATTRS': {x: 'a"&<'}, '*TEXT': '<b>&amp;', c: ['1 < 2'], d: 'x & y'}})
        .toString({noHeader: true}), '<a x="a&quot;&amp;&lt;">&lt;b&gt;&amp;amp;<c>1 &lt; 2</c><d>x &amp; y</d></a>');

    //незакрытые теги не роняют разбор
    assert.deepStrictEqual(parse('<a><b>text'), {a: {b: {'*TEXT': 'text'}}});

    //BOM и XML-декларация пропускаются
    assert.deepStrictEqual(parse('﻿<?xml version="1.0"?><a>t</a>'), {a: {'*TEXT': 't'}});

    //атрибуты: пробел в кавычках, без кавычек, без значения, пространство имён
    assert.deepStrictEqual(parse('<a x="1 2" z=3 w></a>'), {a: {'*ATTRS': {x: '1 2', z: '3', w: true}}});
    const attrs = sax.getAttrsSync(' l:href="#img 1" title="a>b"');
    assert.deepStrictEqual(attrs.get('l:href'), {value: '#img 1', ns: 'l', name: 'href', fn: 'l:href'});
    assert.strictEqual(attrs.get('title').value, 'a>b');
}

module.exports = [testXmlParserTrickyInput];
