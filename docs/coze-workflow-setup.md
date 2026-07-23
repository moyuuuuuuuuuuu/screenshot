# Coze OCR / translation workflow setup

This cloud service expects a published workflow in **Coze China**. The desktop
application never receives Coze credentials and uploads a screenshot only after
the user explicitly requests OCR or translation.

## 1. Create the workflow

Create a workflow in Coze China and configure its Start node with exactly these
inputs:

| Name | Type | Required | Value supplied by this service |
| --- | --- | --- | --- |
| `operation` | String | Yes | `ocr` or `translate` |
| `image` | Image | Yes | The file uploaded by this service |

The cloud adapter uploads the PNG or JPEG to `POST /v1/files/upload`, then passes
the Image input to `POST /v1/workflow/run` as a serialized file reference:

```json
{
  "workflow_id": "<published workflow ID>",
  "parameters": {
    "operation": "ocr",
    "image": "{\"file_id\":\"<uploaded file ID>\"}"
  }
}
```

## 2. Build the node flow

Configure the workflow to:

1. Run OCR on `image`, producing the recognized text and normalized text boxes.
2. Detect the source language and normalize it to exactly `zh` or `en`.
3. Branch on `operation`.
   - For `ocr`, set `translated_text` to JSON `null`.
   - For `translate`, translate Chinese to English or English to Chinese and set
     `translated_text` to the resulting string.
4. Build the End-node object using the exact field names and nesting below.

The End node must return this JSON object. Coze serializes it into the workflow
API response's `data` string:

```json
{
  "source_language": "zh",
  "original_text": "识别文本",
  "translated_text": "recognized text",
  "blocks": [
    {
      "text": "识别文本",
      "confidence": 0.98,
      "box": {
        "x": 0.1,
        "y": 0.2,
        "width": 0.4,
        "height": 0.1
      }
    }
  ]
}
```

All fields are required and no additional fields are accepted. Each block's
`text` must be non-empty, `confidence` must be between `0` and `1`, and its box
must use normalized coordinates between `0` and `1`. The box must remain inside
the image: `x + width <= 1` and `y + height <= 1`.

For an OCR run, `translated_text` must be `null`. For a translation run it must
be a string. Languages other than `zh` and `en` produce the service's
`UNSUPPORTED_LANGUAGE` error.

## 3. Publish and create credentials

1. Test both operation branches in the Coze editor.
2. Publish the workflow. A draft workflow is not callable through the production
   API.
3. Copy its published workflow ID.
4. In Coze's API management area, create a Personal Access Token (PAT) that can
   upload files and run the published workflow.
5. Configure the cloud service environment:

```dotenv
NODE_ENV=production
CLOUD_PROVIDER=coze
HOST=127.0.0.1
PORT=3000
REQUEST_SIGNING_SECRET=<strong server-side signing secret>
CORS_ALLOWED_ORIGINS=http://tauri.localhost,https://tauri.localhost,tauri://localhost
COZE_API_BASE_URL=https://api.coze.cn
COZE_API_TOKEN=<Coze PAT>
COZE_WORKFLOW_ID=<published workflow ID>
```

`COZE_API_BASE_URL`, `COZE_API_TOKEN`, and `COZE_WORKFLOW_ID` are all required
when `CLOUD_PROVIDER=coze`. Production refuses every provider except `coze`.
Development and tests may use `CLOUD_PROVIDER=mock`.

`CORS_ALLOWED_ORIGINS` is an exact, comma-separated allowlist for the desktop
WebView. Keep only the origins used by released clients. Windows Tauri 2 uses
`http://tauri.localhost` by default; `https://tauri.localhost` covers builds
that enable Tauri's HTTPS scheme, and `tauri://localhost` covers the custom
scheme used on other platforms. For local Vite development, add
`http://localhost:1420` or `http://127.0.0.1:1420`. Wildcards, paths, and
malformed origins are rejected at startup.

`HOST` defaults to `127.0.0.1` and `PORT` defaults to `3000`. Set `HOST=0.0.0.0`
only when the deployment platform requires the process to accept external
connections and a network boundary protects the service.

Treat the PAT, signing secret, workflow ID, screenshots, recognized text, and
translations as sensitive. Store secrets only in the cloud deployment's secret
manager. Do not commit them, place them in desktop configuration, send them to
the desktop application, or print them in logs.

Official Coze API references:

- [Upload a file](https://www.coze.cn/open/docs/developer_guides/upload_files)
- [Run a workflow](https://www.coze.cn/open/docs/developer_guides/workflow_run)

## 4. Smoke-test this project's cloud endpoint

From the repository root, install dependencies, compile the cloud package, and
start its runtime entry:

```bash
pnpm install
pnpm --filter @screenshot/cloud build
pnpm --filter @screenshot/cloud start
```

For a development Mock-provider run, set the variables from
`apps/cloud/.env.example` in the shell and use:

```bash
pnpm --filter @screenshot/cloud dev
```

The `dev` command compiles and starts the same runtime entry. This project does
not implicitly load `.env` files; export the variables in the shell or configure
them in the deployment environment before starting.

With the production variables above exported and the server running, generate a
valid request timestamp and HMAC signature using this project's request-signing
contract, then call the OCR endpoint. The following example requires GNU `date`,
`sha256sum`, and `openssl`:

```bash
DEVICE_ID='01234567-89ab-cdef-0123-456789abcdef'
TIMESTAMP="$(date +%s%3N)"
IMAGE_SHA256="$(sha256sum screenshot.png | awk '{print $1}')"
SIGNATURE="$(
  printf '%s\n%s\nocr\n%s' "${DEVICE_ID}" "${TIMESTAMP}" "${IMAGE_SHA256}" |
    openssl dgst -sha256 -hmac "${REQUEST_SIGNING_SECRET}" -hex |
    awk '{print $NF}'
)"

curl --fail-with-body \
  --request POST 'http://127.0.0.1:3000/v1/ocr' \
  --header 'content-type: image/png' \
  --header "x-device-id: ${DEVICE_ID}" \
  --header "x-request-timestamp: ${TIMESTAMP}" \
  --header "x-request-signature: ${SIGNATURE}" \
  --data-binary '@screenshot.png'
```

A successful response uses the stable camelCase service model:

```json
{
  "sourceLanguage": "zh",
  "originalText": "识别文本",
  "translatedText": null,
  "blocks": [
    {
      "text": "识别文本",
      "x": 0.1,
      "y": 0.2,
      "width": 0.4,
      "height": 0.1
    }
  ]
}
```

Live validation cannot be completed until server-side Coze credentials and a
published workflow are supplied. That smoke test remains a release gate; the
automated suite uses injected `fetch` implementations and never contacts Coze.
