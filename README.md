# QRScreen
Scan QR codes from image on laptop.

Give it an image or screenshot and it finds **every** readable QR code in it, like Apple Camera does. Each code gets a yellow outline with its link in a yellow box just below it, and the links are also listed under the image.

Ways to load an image:
- click **Choose image**
- drag and drop an image file onto the page
- paste an image from the clipboard (e.g. take a screenshot with ⌘⇧⌃4, then press ⌘V)

## Run
It's a static site with no build step. It has to be served over HTTP, because ES modules and WebAssembly won't load from `file://`:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.

Decoding uses [zxing-wasm](https://github.com/Sec-ant/zxing-wasm), loaded from jsDelivr, so the first load needs internet access.
