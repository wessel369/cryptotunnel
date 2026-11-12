# Tunnel Vision

A 3D read of BTC price you can fly through.

- **Tentacle** — 15-minute price, thick in the past and tapering toward now. The tip reaches with market bias.
- **Gold line** — 21-day moving average, on the same vertical scale as price.
- **Live road** — 1-minute candles as hills you drive. Cyan and red shoulders are wicks.
- **Camera** — look up/down, zoom, and turn. Follow, inside, big picture, and more.

## Run

```bash
npm install
npm run dev
```

Uses Binance public klines when the network allows; otherwise a synthetic BTC-like series.
