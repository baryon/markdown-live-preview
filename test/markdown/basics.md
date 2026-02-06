---
id: head-metadata
title: Head Metadata
---

<head>
  <html className="some-extra-html-class" />
  <body className="other-extra-body-class" />
  <title>Head Metadata customized title!</title>
  <meta charSet="utf-8" />
  <meta name="twitter:card" content="summary" />
  <link rel="canonical" href="https://docusaurus.io/docs/markdown-features/head-metadata" />
</head>

# Head Metadata

My text

Here is some `inline` code!

---

spaced code block

    var greeting = 'Hello world!';
    console.log(greeting);

---

fenced code block

```
var greeting = 'Hello world!';
console.log(greeting);
```

---

fenced plus language `js`

```js
var greeting = 'Hello world!';
console.log(greeting);
```

---

`js .line-numbers`

```js .line-numbers
var greeting = 'Hello world!';
console.log(greeting);

var greeting2 = 'Hello world2!';
console.log(greeting2);

var greeting3 = 'Hello world3!';
console.log(greeting3);

var greeting4 = 'Hello world4!';
console.log(greeting4);
```

---

`js {hide=true}`

```js {hide=true}
this should not be seen
```

---

`js {cmd=false}`

```js {cmd=false}
var greeting = 'Hello world!';
console.log(greeting);
```

---

`js {literate=false}`

```js {literate=false}
var greeting = 'Hello world!';
console.log(greeting);
```
