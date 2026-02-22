# Stock Price API

Simple Express.js API that returns the closing price for a given stock symbol. No authentication.

Install dependencies:

```bash
cd /Users/I561044/Desktop/myProjects/testAcb
npm install
```

Run server:

```bash
npm start
# or for development with nodemon (if installed):
npm run dev
```

POST /price

- Content-Type: `application/json`
- Body: `{ "symbol": "AAPL" }`

Example curl:

```bash
curl -X POST http://localhost:3000/price \
  -H "Content-Type: application/json" \
  -d '{"symbol":"AAPL"}'
```

Response example:

```
{
  "symbol": "AAPL",
  "close": 171.03,
  "currency": "USD",
  "timestamp": "2026-02-18T21:00:00.000Z"
}
```

Notes:

- This implementation uses Yahoo Finance's public quote endpoint and requires no API key.
- Closing price uses `regularMarketPreviousClose` when available, otherwise `regularMarketPrice`.

Fallback and API key notes:

- Yahoo Finance's public endpoint may return `401 Unauthorized` for some requests or from some networks. If that happens the server will respond with a 502 and provider details.
- You can enable an Alpha Vantage fallback by setting the `ALPHA_VANTAGE_KEY` environment variable. Alpha Vantage requires a (free) API key.

Set the key in macOS zsh and restart the server:

```bash
export ALPHA_VANTAGE_KEY="your_api_key_here"
npm start
```

When the fallback is used, responses include `provider: "alpha_vantage"` and the `timestamp` will be the most recent trading date available from Alpha Vantage.
