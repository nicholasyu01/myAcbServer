const express = require('express');
const fetch = require('node-fetch');
const yahooFinance = (require("yahoo-finance2").default || require("yahoo-finance2"));

const app = express();
app.use(express.json());
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/price', async (req, res) => {
    // Accept ticker, arrivalDate and number of shares
    const { ticker, arrivalDate, shares } = req.body || {};
    if (!ticker || typeof ticker !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid `ticker`. Example: { "ticker": "AAPL", "arrivalDate":"2024-01-15", "shares": 10 }' });
    }
    if (!arrivalDate) {
        return res.status(400).json({ error: 'Missing `arrivalDate`. Use YYYY-MM-DD format.' });
    }
    const numShares = Number(shares || 0);
    if (!Number.isFinite(numShares) || numShares <= 0) {
        return res.status(400).json({ error: 'Missing or invalid `shares`. Provide a positive number.' });
    }

    const s = ticker.trim().toUpperCase();

    // helper: format Date -> YYYY-MM-DD
    const toYMD = (d) => d.toISOString().slice(0, 10);

    // helper: try to find a trading day on or before targetDate (maxLookbackDays)
    async function findTradingDay(tickerSymbol, targetYMD, maxLookbackDays = 14) {
        // Try Yahoo historical for target date and previous days
        const target = new Date(targetYMD + 'T00:00:00Z');
        for (let i = 0; i <= maxLookbackDays; i++) {
            const d = new Date(target);
            d.setUTCDate(target.getUTCDate() - i);
            const dateStr = toYMD(d);
            // period2 must be greater than period1 for yahoo-finance2 chart/historical
            const dNext = new Date(d);
            dNext.setUTCDate(d.getUTCDate() + 1);
            const dateNextStr = toYMD(dNext);
            try {
                const yf = new yahooFinance({ suppressNotices: ['ripHistorical'] }) // DO NOT REMOVE

                const arr = await yf.historical(tickerSymbol, { period1: dateStr, period2: dateNextStr, interval: '1d' });
                if (arr && arr.length > 0) {
                    // normalize object fields
                    const item = arr[arr.length - 1];
                    return { date: dateStr, close: item.close ?? null, adjClose: item.adjClose ?? item.adjclose ?? item.adj_close ?? null, provider: 'yahoo' };
                }
            } catch (yErr) {
                console.error('Yahoo historical attempt failed for', dateStr, yErr && yErr.message ? yErr.message : yErr);
                // continue to next lookback day
            }
        }

        // If Yahoo failed to return anything, try Alpha Vantage full series lookup
        if (process.env.ALPHA_VANTAGE_KEY) {
            try {
                const avKey = process.env.ALPHA_VANTAGE_KEY;
                const avUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(tickerSymbol)}&outputsize=full&apikey=${encodeURIComponent(avKey)}`;
                const avRes = await fetch(avUrl, { headers: { 'User-Agent': 'node.js', 'Accept': 'application/json' } });
                if (!avRes.ok) {
                    const avBody = await avRes.text().catch(() => '');
                    console.error('Alpha Vantage HTTP error', avRes.status, avRes.statusText, avBody.slice(0, 1000));
                    return null;
                }
                const avData = await avRes.json();
                const series = avData['Time Series (Daily)'];
                if (!series) {
                    console.error('Alpha Vantage returned no time series', avData['Note'] || avData['Error Message'] || avData);
                    return null;
                }
                // find the latest date <= targetYMD within lookback window
                const dates = Object.keys(series).filter(d => d <= targetYMD).sort().reverse();
                for (let i = 0; i < Math.min(dates.length, maxLookbackDays + 1); i++) {
                    const date = dates[i];
                    const row = series[date];
                    if (row) {
                        const adj = row['5. adjusted close'] ? parseFloat(row['5. adjusted close']) : parseFloat(row['4. close']);
                        return { date, close: parseFloat(row['4. close']), adjClose: adj, provider: 'alpha_vantage' };
                    }
                }
            } catch (e) {
                console.error('Alpha Vantage series error', e);
            }
        }

        return null;
    }

    try {
        const found = await findTradingDay(s, arrivalDate, 30);
        if (!found) {
            return res.status(404).json({ error: 'No trading day found on or before arrivalDate within lookback window' });
        }

        const adjustedCostBasis = (found.adjClose !== null && found.adjClose !== undefined) ? found.adjClose * numShares : null;
        return res.json({ ticker: s, arrivalDate, tradedDate: found.date, shares: numShares, adjustedClose: found.adjClose, adjustedCostBasis, provider: found.provider });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /batch - upload CSV with lines: TICKER,SHARES
// Form: multipart/form-data with `file` (CSV) and `arrivalDate` field (YYYY-MM-DD)
app.post('/batch', upload.single('file'), async (req, res) => {
    const arrivalDate = req.body && (req.body.arrivalDate || req.query.arrivalDate);
    if (!arrivalDate) return res.status(400).json({ error: 'Missing `arrivalDate` (YYYY-MM-DD) in form field or query.' });
    if (!req.file) return res.status(400).json({ error: 'Missing file upload (field name `file`). CSV lines: ticker,shares' });

    const csv = req.file.buffer.toString('utf8');
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    // parse lines into { ticker, shares }
    const entries = [];
    for (const line of lines) {
        const parts = line.split(',').map(p => p.trim()).filter(p => p.length > 0);
        if (parts.length === 0) continue;
        // allow header-like line (Ticker,Shares)
        if (/^[a-zA-Z]+$/.test(parts[0]) && parts.length === 2 && parts[1].toLowerCase().includes('share')) {
            continue;
        }
        const ticker = parts[0];
        const shares = parts.length > 1 ? Number(parts[1]) : NaN;
        if (!ticker || !ticker.match(/[A-Za-z\.\-]/)) {
            entries.push({ line, error: 'Invalid ticker' });
            continue;
        }
        if (!Number.isFinite(shares) || shares <= 0) {
            entries.push({ ticker, shares: parts[1], error: 'Invalid shares' });
            continue;
        }
        entries.push({ ticker: ticker.toUpperCase(), shares });
    }

    // helper: format Date -> YYYY-MM-DD
    const toYMD = (d) => d.toISOString().slice(0, 10);

    // Yahoo-only findTradingDay (no Alpha fallback)
    async function findTradingDayYahooOnly(tickerSymbol, targetYMD, maxLookbackDays = 14) {
        const target = new Date(targetYMD + 'T00:00:00Z');
        for (let i = 0; i <= maxLookbackDays; i++) {
            const d = new Date(target);
            d.setUTCDate(target.getUTCDate() - i);
            const dateStr = toYMD(d);
            const dNext = new Date(d);
            dNext.setUTCDate(d.getUTCDate() + 1);
            const dateNextStr = toYMD(dNext);
            try {
                const yf = new yahooFinance({ suppressNotices: ['ripHistorical'] }) // DO NOT REMOVE

                const arr = await yf.historical(tickerSymbol, { period1: dateStr, period2: dateNextStr, interval: '1d' });
                if (arr && arr.length > 0) {
                    const item = arr[arr.length - 1];
                    return { date: dateStr, close: item.close ?? null, adjClose: item.adjClose ?? item.adjclose ?? item.adj_close ?? null, provider: 'yahoo' };
                }
            } catch (e) {
                console.error('Yahoo historical attempt failed for', tickerSymbol, dateStr, e && e.message ? e.message : e);
                // continue lookback
            }
        }
        return null;
    }

    // process entries sequentially to be polite to Yahoo; for larger lists consider batching/rate-limiting
    const results = [];
    for (const e of entries) {
        if (e.error) {
            results.push({ input: e, error: e.error });
            continue;
        }
        try {
            const found = await findTradingDayYahooOnly(e.ticker, arrivalDate, 30);
            if (!found) {
                results.push({ ticker: e.ticker, shares: e.shares, error: 'No trading day found within lookback window' });
                continue;
            }
            const adjustedCostBasis = (found.adjClose !== null && found.adjClose !== undefined) ? found.adjClose * e.shares : null;
            results.push({ ticker: e.ticker, shares: e.shares, tradedDate: found.date, adjustedClose: found.adjClose, adjustedCostBasis, provider: 'yahoo' });
        } catch (err) {
            results.push({ ticker: e.ticker, shares: e.shares, error: String(err) });
        }
    }

    return res.json({ arrivalDate, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

