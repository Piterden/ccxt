'use strict';

//  ---------------------------------------------------------------------------

const Exchange = require ('./base/Exchange');
const { ExchangeError } = require ('./base/errors');

//  ---------------------------------------------------------------------------

module.exports = class gemini extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            id: 'gemini',
            name: 'Gemini',
            countries: ['US'],
            rateLimit: 1500, // 200 for private API
            version: 'v1',
            has: {
                fetchDepositAddress: false,
                createDepositAddress: true,
                CORS: false,
                fetchBidsAsks: false,
                fetchTickers: false,
                fetchMyTrades: true,
                fetchOrder: true,
                fetchOrders: false,
                fetchOpenOrders: true,
                fetchClosedOrders: false,
                createMarketOrder: false,
                withdraw: true,
                fetchTransactions: true,
                fetchWithdrawals: false,
                fetchDeposits: false,
            },
            urls: {
                logo: 'https://user-images.githubusercontent.com/1294454/27816857-ce7be644-6096-11e7-82d6-3c257263229c.jpg',
                api: 'https://api.gemini.com',
                www: 'https://gemini.com',
                doc: [
                    'https://docs.gemini.com/rest-api',
                    'https://docs.sandbox.gemini.com',
               ],
                test: 'https://api.sandbox.gemini.com',
                fees: [
                    'https://gemini.com/fee-schedule/',
                    'https://gemini.com/transfer-fees/',
               ],
            },
            api: {
                public: {
                    get: [
                        'symbols',
                        'pubticker/{symbol}',
                        'book/{symbol}',
                        'trades/{symbol}',
                        'auction/{symbol}',
                        'auction/{symbol}/history',
                   ],
                },
                private: {
                    post: [
                        'order/new',
                        'order/cancel',
                        'order/cancel/session',
                        'order/cancel/all',
                        'order/status',
                        'orders',
                        'mytrades',
                        'tradevolume',
                        'transfers',
                        'balances',
                        'deposit/{currency}/newAddress',
                        'withdraw/{currency}',
                        'heartbeat',
                        'transfers',
                   ],
                },
            },
            fees: {
                trading: {
                    taker: 0.0025,
                    maker: 0.0025,
                },
            },
        });
    }

    async fetchMarkets () {
        let markets = await this.publicGetSymbols ();
        let result = [];
        for (let p = 0; p < markets.length; p++) {
            let id = markets[p];
            let market = id;
            let uppercase = market.toUpperCase ();
            let base = uppercase.slice (0, 3);
            let quote = uppercase.slice (3, 6);
            let symbol = base + '/' + quote;
            result.push ({
                id,
                symbol,
                base,
                quote,
                info: market,
            });
        }
        return result;
    }

    async fetchOrderBook (symbol, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let orderbook = await this.publicGetBookSymbol (this.extend ({
            symbol: this.marketId (symbol),
        }, params));
        return this.parseOrderBook (orderbook, undefined, 'bids', 'asks', 'price', 'amount');
    }

    async fetchTicker (symbol, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let ticker = await this.publicGetPubtickerSymbol (this.extend ({
            symbol: market['id'],
        }, params));
        let timestamp = ticker['volume']['timestamp'];
        let baseVolume = market['base'];
        let quoteVolume = market['quote'];
        let last = this.safeFloat (ticker, 'last');
        return {
            symbol,
            timestamp,
            datetime: this.iso8601 (timestamp),
            high: undefined,
            low: undefined,
            bid: this.safeFloat (ticker, 'bid'),
            bidVolume: undefined,
            ask: this.safeFloat (ticker, 'ask'),
            askVolume: undefined,
            vwap: undefined,
            open: undefined,
            close: last,
            last,
            previousClose: undefined,
            change: undefined,
            percentage: undefined,
            average: undefined,
            baseVolume: parseFloat (ticker['volume'][baseVolume]),
            quoteVolume: parseFloat (ticker['volume'][quoteVolume]),
            info: ticker,
        };
    }

    parseTrade (trade, market) {
        let timestamp = trade['timestampms'];
        let order = undefined;
        if ('order_id' in trade)
            order = trade['order_id'].toString ();
        let fee = this.safeFloat (trade, 'fee_amount');
        if (typeof fee !== 'undefined') {
            let currency = this.safeString (trade, 'fee_currency');
            if (typeof currency !== 'undefined') {
                if (currency in this.currencies_by_id)
                    currency = this.currencies_by_id[currency]['code'];
                currency = this.commonCurrencyCode (currency);
            }
            fee = {
                cost: this.safeFloat (trade, 'fee_amount'),
                currency,
            };
        }
        let price = this.safeFloat (trade, 'price');
        let amount = this.safeFloat (trade, 'amount');
        return {
            id: trade['tid'].toString (),
            order,
            info: trade,
            timestamp,
            datetime: this.iso8601 (timestamp),
            symbol: market['symbol'],
            type: undefined,
            side: trade['type'].toLowerCase (),
            price,
            cost: price * amount,
            amount,
            fee,
        };
    }

    async fetchTrades (symbol, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let response = await this.publicGetTradesSymbol (this.extend ({
            symbol: market['id'],
        }, params));
        return this.parseTrades (response, market, since, limit);
    }

    async fetchBalance (params = {}) {
        await this.loadMarkets ();
        let balances = await this.privatePostBalances ();
        let result = { info: balances };
        for (let b = 0; b < balances.length; b++) {
            let balance = balances[b];
            let currency = balance['currency'];
            let account = {
                free: parseFloat (balance['available']),
                used: 0.0,
                total: parseFloat (balance['amount']),
            };
            account['used'] = account['total'] - account['free'];
            result[currency] = account;
        }
        return this.parseBalance (result);
    }

    parseOrder (order, market = undefined) {
        let timestamp = order['timestampms'];
        let amount = this.safeFloat (order, 'original_amount');
        let remaining = this.safeFloat (order, 'remaining_amount');
        let filled = this.safeFloat (order, 'executed_amount');
        let status = 'closed';
        if (order['is_live']) {
            status = 'open';
        }
        if (order['is_cancelled']) {
            status = 'canceled';
        }
        let price = this.safeFloat (order, 'price');
        let average = this.safeFloat (order, 'avg_execution_price');
        if (average !== 0.0) {
            price = average; // prefer filling (execution) price over the submitted price
        }
        let cost = undefined;
        if (typeof filled !== 'undefined') {
            if (typeof average !== 'undefined') {
                cost = filled * average;
            }
        }
        let type = this.safeString (order, 'type');
        if (type === 'exchange limit') {
            type = 'limit';
        } else if (type === 'market buy' || type === 'market sell') {
            type = 'market';
        } else {
            type = order['type'];
        }
        let fee = undefined;
        let symbol = undefined;
        if (typeof market === 'undefined') {
            let marketId = this.safeString (order, 'symbol');
            if (marketId in this.markets_by_id) {
                market = this.markets_by_id[marketId];
            }
        }
        if (typeof market !== 'undefined') {
            symbol = market['symbol'];
        }
        return {
            id: order['order_id'],
            info: order,
            timestamp,
            datetime: this.iso8601 (timestamp),
            lastTradeTimestamp: undefined,
            status,
            symbol,
            type,
            side: order['side'].toLowerCase (),
            price,
            average,
            cost,
            amount,
            filled,
            remaining,
            fee,
        };
    }

    async fetchOrder (id, symbol = undefined, params = {}) {
        await this.loadMarkets ();
        let response = await this.privatePostOrderStatus (this.extend ({
            order_id,
        }, params));
        return this.parseOrder (response);
    }

    async fetchOpenOrders (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let response = await this.privatePostOrders (params);
        let orders = this.parseOrders (response, undefined, since, limit);
        if (typeof symbol !== 'undefined') {
            let market = this.market (symbol); // throws on non-existent symbol
            orders = this.filterBySymbol (orders, market['symbol']);
        }
        return orders;
    }

    async createOrder (symbol, type, side, amount, price = undefined, params = {}) {
        await this.loadMarkets ();
        if (type === 'market')
            throw new ExchangeError (this.id + ' allows limit orders only');
        let nonce = this.nonce ();
        let order = {
            client_order_id: nonce.toString (),
            symbol: this.marketId (symbol),
            amount: amount.toString (),
            price: price.toString (),
            side,
            type: 'exchange limit', // gemini allows limit orders only
        };
        let response = await this.privatePostOrderNew (this.extend (order, params));
        return {
            info: response,
            id: response['order_id'],
        };
    }

    async cancelOrder (id, symbol = undefined, params = {}) {
        await this.loadMarkets ();
        return await this.privatePostOrderCancel ({ order_id: id });
    }

    async fetchMyTrades (symbol = undefined, since = undefined, limit = undefined, params = {}) {
        if (typeof symbol === 'undefined')
            throw new ExchangeError (this.id + ' fetchMyTrades requires a symbol argument');
        await this.loadMarkets ();
        let market = this.market (symbol);
        let request = {
            symbol: market['id'],
        };
        if (typeof limit !== 'undefined')
            request['limit_trades'] = limit;
        if (typeof since !== 'undefined')
            request['timestamp'] = parseInt (since / 1000);
        let response = await this.privatePostMytrades (this.extend (request, params));
        return this.parseTrades (response, market, since, limit);
    }

    async withdraw (code, amount, address, tag = undefined, params = {}) {
        this.checkAddress (address);
        await this.loadMarkets ();
        let currency = this.currency (code);
        let response = await this.privatePostWithdrawCurrency (this.extend ({
            currency: currency['id'],
            amount,
            address,
        }, params));
        return {
            info: response,
            id: this.safeString (response, 'txHash'),
        };
    }

    nonce () {
        return this.milliseconds ();
    }

    async fetchTransactions (code = undefined, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let request = {};
        let response = await this.privatePostTransfers (this.extend (request, params));
        return this.parseTransactions (response);
    }

    parseTransaction (transaction, currency = undefined) {
        let timestamp = this.safeInteger (transaction, 'timestampms');
        let datetime = undefined;
        if (typeof timestamp !== 'undefined')
            datetime = this.iso8601 (timestamp);
        let code = undefined;
        if (typeof currency === 'undefined') {
            let currencyId = this.safeString (transaction, 'currency');
            if (currencyId in this.currencies_by_id) {
                currency = this.currencies_by_id[currencyId];
            }
        }
        if (typeof currency !== 'undefined') {
            code = currency['code'];
        }
        let type = this.safeString (transaction, 'type');
        if (typeof type !== 'undefined') {
            type = type.toLowerCase ();
        }
        let status = 'pending';
        // When deposits show as Advanced or Complete they are available for trading.
        if (transaction['status'])
            status = 'ok';
        return {
            info: transaction,
            id: this.safeString (transaction, 'eid'),
            txid: this.safeString (transaction, 'txHash'),
            timestamp,
            datetime,
            address: undefined, // or is it defined?
            type, // direction of the transaction, ('deposit' | 'withdraw')
            amount: this.safeFloat (transaction, 'amount'),
            currency: code,
            status,
            updated: undefined,
            fee: {
                cost: undefined,
                rate: undefined,
            },
        };
    }

    sign (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let url = '/' + this.version + '/' + this.implodeParams (path, params);
        let query = this.omit (params, this.extractParams (path));
        if (api === 'public') {
            if (Object.keys (query).length)
                url += '?' + this.urlencode (query);
        } else {
            this.checkRequiredCredentials ();
            let nonce = this.nonce ();
            let request = this.extend ({
                request: url,
                nonce,
            }, query);
            let payload = this.json (request);
            payload = this.stringToBase64 (this.encode (payload));
            let signature = this.hmac (payload, this.encode (this.secret), 'sha384');
            headers = {
                'Content-Type': 'text/plain',
                'X-GEMINI-APIKEY': this.apiKey,
                'X-GEMINI-PAYLOAD': this.decode (payload),
                'X-GEMINI-SIGNATURE': signature,
            };
        }
        url = this.urls['api'] + url;
        return { url, method, body, headers: headers };
    }

    async request (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let response = await this.fetch2 (path, api, method, params, headers, body);
        if ('result' in response)
            if (response['result'] === 'error')
                throw new ExchangeError (this.id + ' ' + this.json (response));
        return response;
    }

    async createDepositAddress (code, params = {}) {
        await this.loadMarkets ();
        let currency = this.currency (code);
        let response = await this.privatePostDepositCurrencyNewAddress (this.extend ({
            currency: currency['id'],
        }, params));
        let address = this.safeString (response, 'address');
        this.checkAddress (address);
        return {
            currency: code,
            address,
            info: response,
        };
    }
};
