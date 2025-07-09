(function(){
    'use strict';

    const AutoTraiderVersion = '6.2';

    const DEFAULT_SETTINGS = {
        settingsVersion: AutoTraiderVersion,
        enabled: true,
        showPhases: true,
        showAdvice: true,
        showDetails: true,
        buyThreshold: 0.95,
        sellThreshold: 1.10,
        historyLength: 200,
        telegramEnabled: false,
        telegramToken: '',
        telegramChatId: '',
        sendPriceUpdates: true,
        sendTradeUpdates: true,
        showLogWindow: false,
        momentumTicks: 2,
        trailingStopPct: 0.98,
        partialSellPct: 0.5,
        topAssetsCount: 3,
        analyzeInterval: 300
    };

    const COLORS = {
        buyBg:  'rgba(0,255,255,0.15)',
        sellBg: 'rgba(255,100,100,0.15)'
    };
	    const AutoTraider = {
        name: 'Auto Traider',
        logicLastTick:  -1,
        telegramOffset: 0,
        _started:       false,
        _tickMessages:  [],

        MODES: [
            "Стабильная","Медленный рост","Медленное падение",
            "Быстрый рост","Быстрое падение","Колебания"
        ],

        settings:       {},
        priceHistory:   {},
        lastPrice:      {},
        prevStock:      {},
        positions:      {},
        topVolIndices:  [],

        save() {
            localStorage.setItem(this.name, JSON.stringify({
                settings:       this.settings,
                telegramOffset: this.telegramOffset
            }));
        },

        load() {
            const raw = localStorage.getItem(this.name);
            if (raw) {
                try {
                    const obj = JSON.parse(raw);
                    this.settings = Object.assign({}, DEFAULT_SETTINGS, obj.settings || {});
                    this.settings.settingsVersion = AutoTraiderVersion;
                    this.telegramOffset = obj.telegramOffset || 0;
                } catch {
                    this.settings = Object.assign({}, DEFAULT_SETTINGS);
                }
            } else {
                this.settings = Object.assign({}, DEFAULT_SETTINGS);
            }
        },

        initData() {
            const objs = Game.ObjectsById;
            if (!objs || !objs[5] || !objs[5].minigame) return;
            const M = objs[5].minigame;
            this.priceHistory = {};
            this.lastPrice    = {};
            this.prevStock    = {};
            this.positions    = {};
            M.goodsById.forEach((g,i) => {
                this.priceHistory[i] = [];
                this.lastPrice[i]    = g.val;
                this.prevStock[i]    = g.stock;
            });
        },

        updateHistory(i, val) {
            const hist = this.priceHistory[i] ||= [];
            hist.push(val);
            if (hist.length > this.settings.historyLength) hist.shift();
        },

        isMomentumUp(i) {
            const hist = this.priceHistory[i];
            if (!hist || hist.length < this.settings.momentumTicks + 1) return false;
            for (let k = hist.length - this.settings.momentumTicks; k < hist.length; k++) {
                if (hist[k] <= hist[k-1]) return false;
            }
            return true;
        },

        analyzeMarket() {
            const objs = Game.ObjectsById;
            if (!objs || !objs[5] || !objs[5].minigame) return;
            const M = objs[5].minigame;
            const scores = M.goodsById.map((g,i) => {
                const h = this.priceHistory[i] || [];
                if (h.length < 2) return { i, vol: 0 };
                const mn = Math.min(...h), mx = Math.max(...h);
                return { i, vol: (mx - mn) / mn };
            });
            scores.sort((a,b) => b.vol - a.vol);
            this.topVolIndices = scores
                .slice(0, this.settings.topAssetsCount)
                .map(x => x.i);
            const summary = scores
                .slice(0, this.settings.topAssetsCount)
                .map(x => `${M.goodsById[x.i].name}:${(x.vol*100).toFixed(1)}%`)
                .join(', ');
            AutoTraiderLog.log('market', { summary });
        },

        runLogicLoop() {
            const objs = Game.ObjectsById;
            if (!objs || !objs[5] || !objs[5].minigame) return;
            const M = objs[5].minigame;
            if (M.ticks === this.logicLastTick) return;
            this.logicLastTick = M.ticks;

            if (!Object.keys(this.priceHistory).length) {
                this.initData();
                this.analyzeMarket();
            }

            if (M.ticks % this.settings.analyzeInterval === 0) {
                this.analyzeMarket();
            }

            if (!this._started) {
                AutoTraiderLog.log('start');
                this._started = true;
            }
            this._tickMessages = [];

            M.goodsById.forEach((g,i) => {
                const now = g.val, old = this.lastPrice[i];

                if (now !== old) {
                    AutoTraiderLog.log('price', { name: g.name, old, now });
                    if (this.settings.sendPriceUpdates) {
                        this._tickMessages.push(
                            `${g.name}: ${Beautify(old,2)} → ${Beautify(now,2)}`
                        );
                    }
                }
                this.lastPrice[i] = now;
                this.updateHistory(i, now);

                const pos = this.positions[i];
                if (pos) {
                    pos.peakPrice = Math.max(pos.peakPrice, now);

                    if (!pos.partialSold && now >= pos.entryPrice * this.settings.sellThreshold) {
                        const qty = Math.floor(pos.qty * this.settings.partialSellPct);
                        if (qty > 0) {
                            M.sellGood(i, qty);
                            AutoTraiderLog.log('partialSell', {
                                name:       g.name,
                                qty:        qty,
                                price:      now,
                                entryPrice: pos.entryPrice
                            });
                            pos.qty = pos.qty - qty;
                            pos.partialSold = true;
                            if (this.settings.sendTradeUpdates) {
                                const pctPart = (now / pos.entryPrice - 1) * 100;
                                const pctTextPart = (pctPart >= 0 ? '+' : '') + pctPart.toFixed(2) + '%';
                                this._tickMessages.push(
                                    `PSELL ${g.name} B(${Beautify(pos.entryPrice,2)}) → S(${Beautify(now,2)}) ${pctTextPart}`
                                );
                            }
                        }
                    }
                    else if (pos.partialSold && now <= pos.peakPrice * this.settings.trailingStopPct) {
                        const qty2 = pos.qty;
                        M.sellGood(i, qty2);
                        AutoTraiderLog.log('sell', {
                            name:       g.name,
                            qty:        qty2,
                            price:      now,
                            entryPrice: pos.entryPrice
                        });
                        delete this.positions[i];
                        if (this.settings.sendTradeUpdates) {
                            const pctFull = (now / pos.entryPrice - 1) * 100;
                            const pctTextFull = (pctFull >= 0 ? '+' : '') + pctFull.toFixed(2) + '%';
                            this._tickMessages.push(
                                `SELL ${g.name} B(${Beautify(pos.entryPrice,2)}) → S(${Beautify(now,2)}) ${pctTextFull}`
                            );
                        }
                    }
                }
                else if (
                    this.settings.enabled &&
                    this.topVolIndices.includes(i) &&
                    now <= M.getRestingVal(i) * this.settings.buyThreshold &&
                    this.isMomentumUp(i) &&
                    g.active && ![2,4].includes(g.mode)
                ) {
                    const q = Math.floor(Game.cookies / now);
                    if (q > 0) {
                        M.buyGood(i, q);
                        this.positions[i] = {
                            entryPrice: now,
                            peakPrice:  now,
                            qty:        q,
                            partialSold:false
                        };
                        AutoTraiderLog.log('buy', { name: g.name, qty: q, price: now });
                        if (this.settings.sendTradeUpdates) {
                            this._tickMessages.push(
                                `BUY ${g.name} x${q}@${Beautify(now,2)}`
                            );
                        }
                    }
                }

                this.updateUIForGood(i, g, M);
                this.prevStock[i] = g.stock;
            });

            if (this._tickMessages.length && this.settings.sendTradeUpdates) {
                const header = `Auto Traider [${new Date().toLocaleTimeString()}]\n`;
                this.sendTelegram(header + this._tickMessages.join('\n'));
            }
        },

        sendTelegram(text) {
            if (!this.settings.telegramEnabled ||
                !this.settings.telegramToken ||
                !this.settings.telegramChatId) return;
            fetch(
                `https://api.telegram.org/bot${this.settings.telegramToken}/sendMessage`,
                {
                    method: 'POST',
                    headers:{ 'Content-Type':'application/json' },
                    body: JSON.stringify({
                        chat_id: this.settings.telegramChatId,
                        text:    text
                    })
                }
            ).catch(console.error);
        },

        pollTelegramCommands() {
            if (!this.settings.telegramEnabled ||
                !this.settings.telegramToken ||
                !this.settings.telegramChatId) return;
            fetch(
                `https://api.telegram.org/bot${this.settings.telegramToken}/getUpdates?offset=${this.telegramOffset}`
            )
            .then(r => r.json())
            .then(json => {
                if (json.error_code === 409) {
                    this.telegramOffset = 0;
                    this.save();
                    return;
                }
                if (!json.ok || !json.result) return;
                for (const upd of json.result) {
                    this.telegramOffset = upd.update_id + 1;
                    const msg = upd.message;
                    if (
                        msg?.chat?.id.toString() === this.settings.telegramChatId.toString()
                        && msg.text.trim() === '/prices'
                    ) {
                        this.sendAllPrices();
                    }
                }
            })
            .catch(console.error);
        },

        sendAllPrices() {
            const objs = Game.ObjectsById;
            if (!objs || !objs[5] || !objs[5].minigame) {
                this.sendTelegram('Мини-игра неактивна.');
                return;
            }
            const M = objs[5].minigame;
            const lines = M.goodsById.map(g =>
                `${g.name}: $${Beautify(g.val,2)}`
            );
            this.sendTelegram('Текущие цены:\n' + lines.join('\n'));
        },

        ensureUIElements(i) {
            const el = document.getElementById(`bankGood-${i}`);
            if (!el) return null;
            let phase   = document.getElementById(`AT-phase-${i}`);
            let advice  = document.getElementById(`AT-adv-${i}`);
            let details = document.getElementById(`AT-det-${i}`);
            if (!phase) {
                phase = document.createElement('div');
                phase.id = `AT-phase-${i}`;
                phase.style.fontSize = '11px';
                phase.style.color    = '#888';
                el.appendChild(phase);
            }
            if (!advice) {
                advice = document.createElement('div');
                advice.id = `AT-adv-${i}`;
                advice.style.fontSize   = '13px';
                advice.style.fontWeight = 'bold';
                el.appendChild(advice);
            }
            if (!details) {
                details = document.createElement('div');
                details.id = `AT-det-${i}`;
                details.style.fontSize    = '10px';
                details.style.color       = '#ccc';
                details.style.whiteSpace  = 'pre-line';
                el.appendChild(details);
            }
            return { el, phase, advice, details };
        },

        updateUIForGood(i, g, M) {
            const ui = this.ensureUIElements(i);
            if (!ui) return;
            const { el, phase, advice, details } = ui;
            phase.textContent = this.settings.showPhases
                ? `Фаза: ${this.MODES[g.mode] || 'Неизвестно'}` : '';
            let txt = '';
            if (this.settings.showAdvice) {
                if (this.positions[i]) {
                    txt = 'HOLD';
                    el.style.backgroundColor = COLORS.sellBg;
                }
                else if (g.val <= M.getRestingVal(i) * this.settings.buyThreshold) {
                    txt = 'BUY?';
                    el.style.backgroundColor = COLORS.buyBg;
                }
                else {
                    el.style.backgroundColor = '';
                }
            } else {
                el.style.backgroundColor = '';
            }
            advice.textContent = txt;
            if (this.settings.showDetails) {
                const h = this.priceHistory[i] || [];
                const mn = h.length ? Beautify(Math.min(...h),2) : '-';
                const mx = h.length ? Beautify(Math.max(...h),2) : '-';
                details.innerHTML = `Min: ${mn}<br>Max: ${mx}`;
            } else {
                details.textContent = '';
            }
        },

        injectMenu() {
            const menu = l('menu');
            if (menu.querySelector('#AutoTraiderMenu')) return;
            const section = document.createElement('div');
            section.className = 'subsection';
            section.id = 'AutoTraiderMenu';

            const title = document.createElement('div');
            title.className = 'title';
            title.textContent = 'Auto Traider';
            section.appendChild(title);

            const list = document.createElement('div');
            list.className = 'listing';

            const addToggle = (key, label) => {
                const btn = document.createElement('a');
                btn.className = 'smallFancyButton option' + (this.settings[key] ? '' : ' off');
                btn.textContent = `${label}: ${this.settings[key] ? 'ON' : 'OFF'}`;
                btn.onclick = () => {
                    this.settings[key] = !this.settings[key];
                    if (key === 'telegramEnabled' && this.settings.telegramEnabled) {
                        this.save();
                    }
                    if (key === 'showLogWindow') {
                        AutoTraiderLog.init(this.settings);
                        Game.UpdateMenu();
                    }
                    btn.className = 'smallFancyButton option' + (this.settings[key] ? '' : ' off');
                    btn.textContent = `${label}: ${this.settings[key] ? 'ON' : 'OFF'}`;
                    this.save();
                };
                list.appendChild(btn);
                list.appendChild(document.createElement('br'));
            };

            addToggle('enabled',          'Auto-Traider');
            addToggle('showPhases',       'Show Phases');
            addToggle('showAdvice',       'Show Advice');
            addToggle('showDetails',      'Show Details');
            addToggle('telegramEnabled',  'Telegram Alerts');
            addToggle('showLogWindow',    'Show Log Window');

            if (this.settings.telegramEnabled) {
                const lbl1 = document.createElement('label');
                lbl1.textContent = 'Bot Token: ';
                const tkn = document.createElement('input');
                tkn.type     = 'text';
                tkn.value    = this.settings.telegramToken;
                tkn.onchange = () => { this.settings.telegramToken = tkn.value; this.save(); };
                lbl1.appendChild(tkn);
                list.appendChild(lbl1);
                list.appendChild(document.createElement('br'));

                const lbl2 = document.createElement('label');
                lbl2.textContent = 'Chat ID: ';
                const cid = document.createElement('input');
                cid.type     = 'text';
                cid.value    = this.settings.telegramChatId;
                cid.onchange = () => { this.settings.telegramChatId = cid.value; this.save(); };
                lbl2.appendChild(cid);
                list.appendChild(lbl2);
                list.appendChild(document.createElement('br'));

                addToggle('sendPriceUpdates', 'Log Prices to Telegram');
                addToggle('sendTradeUpdates', 'Log Trades to Telegram');
            }

            const addNumber = (key, label, step, desc) => {
                const lbl = document.createElement('label');
                lbl.textContent = label + ': ';
                const inp = document.createElement('input');
                inp.type     = 'number';
                inp.step     = step;
                inp.value    = this.settings[key];
                inp.onchange = () => { this.settings[key] = parseFloat(inp.value); this.save(); };
                lbl.appendChild(inp);
                list.appendChild(lbl);

                const d = document.createElement('label');
                d.style.marginLeft = '6px';
                d.style.color = '#888';
                d.textContent = desc;
                list.appendChild(d);
                list.appendChild(document.createElement('br'));
            };

            addNumber('buyThreshold', 'Buy Threshold', 0.01, 'доля от опорного значения (resting value)');
            addNumber('sellThreshold', 'Sell Threshold', 0.01, 'множитель от цены покупки');
            addNumber('momentumTicks', 'Momentum Ticks', 1, 'количество тиков роста подряд');
            addNumber('trailingStopPct', 'Trailing Stop %', 0.01, 'процент от пикового значения для трейлинг-стопа');
            addNumber('partialSellPct', 'Partial Sell %', 0.01, 'доля позиции для первой продажи');
            addNumber('topAssetsCount', 'Top Assets', 1, 'количество активов для анализа');
            addNumber('analyzeInterval', 'Analyze Interval', 1, 'интервал анализа рынка в тиках');

            const btnA = document.createElement('a');
            btnA.className = 'smallFancyButton';
            btnA.textContent = 'Analyze Market';
            btnA.onclick = () => this.analyzeMarket();
            list.appendChild(btnA);

            const btnDesc = document.createElement('label');
            btnDesc.style.marginLeft = '6px';
            btnDesc.style.color = '#888';
            btnDesc.textContent = 'принудительно пересчитать топ-волатильные активы';
            list.appendChild(btnDesc);

            section.appendChild(list);
            const last = menu.querySelector('.subsection:last-of-type');
            if (last) last.after(section);
        },

        startLogic() {
            if (!this.hooked) {
                Game.registerHook('logic', () => this.runLogicLoop());
                this.hooked = true;
            }
            AutoTraiderLog.init(this.settings);
            if (!this.intervalId) {
                this.intervalId = setInterval(() => {
                    this.runLogicLoop();
                    this.pollTelegramCommands();
                }, 1000);
            }
        },

        init() {
            this.load();
            const self = this;
            function wait() {
                const objs = Game.ObjectsById;
                if (!objs || !objs[5] || !objs[5].minigame) {
                    return setTimeout(wait, 500);
                }
                const origUpdateMenu = Game.UpdateMenu;
                Game.UpdateMenu = function() {
                    origUpdateMenu();
                    if (Game.onMenu === 'prefs') self.injectMenu();
                };
                self.startLogic();
            }
            wait();
        }
    };

    const AutoTraiderLog = {
        logs: [],

        init(settings) {
            let win = document.getElementById('AT-log-window');
            if (!win) {
                win = document.createElement('div');
                win.id = 'AT-log-window';
                Object.assign(win.style, {
                    position:    'fixed',
                    bottom:      '10px',
                    right:       '10px',
                    width:       '320px',
                    height:      '400px',
                    background:  '#222',
                    color:       '#eee',
                    fontSize:    '12px',
                    overflowY:   'auto',
                    padding:     '8px',
                    zIndex:      '9999'
                });

                const header = document.createElement('div');
                header.id = 'AT-log-header';
                Object.assign(header.style, {
                    position:     'sticky',
                    top:          '0',
                    background:   '#222',
                    padding:      '4px 0',
                    marginBottom: '4px',
                    zIndex:       '1'
                });

                const btnClear = document.createElement('button');
                btnClear.textContent = 'Clear';
                btnClear.onclick = function(){
                    AutoTraiderLog.logs = [];
                    win.querySelectorAll('div.log-entry').forEach(el => el.remove());
                };
                header.appendChild(btnClear);

                const btnCopy = document.createElement('button');
                btnCopy.textContent = 'Copy';
                btnCopy.style.marginLeft = '4px';
                btnCopy.onclick = function(){
                    const text = AutoTraiderLog.logs.join('\n');
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text);
                    } else {
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                    }
                };
                header.appendChild(btnCopy);

                win.appendChild(header);
                document.body.appendChild(win);
            }
            win.style.display = settings.showLogWindow ? 'block' : 'none';
        },

        log(type, data) {
            const ts = new Date().toLocaleTimeString();
            const entry = document.createElement('div');
            entry.className = 'log-entry';

            if (type === 'start') {
                entry.textContent = `[${ts}] Auto Traider запущен.`;
                entry.style.color = '#eee';
            }
            else if (type === 'market') {
                entry.textContent = `[${ts}] Market top vol: ${data.summary}`;
                entry.style.color = '#eee';
            }
            else if (type === 'buy') {
                entry.textContent = `[${ts}] BUY ${data.name} x${data.qty} @ $${data.price.toFixed(2)}`;
                entry.style.color = '#0ff';
            }
            else if (type === 'partialSell' || type === 'sell') {
                const pct     = (data.price / data.entryPrice - 1) * 100;
                const pctText = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
                const color   = pct >= 0 ? '#8f8' : '#f88';
                const action  = type === 'partialSell' ? 'PARTIAL SELL' : 'SELL';
                const entryText = `[${ts}] ${action} ${data.name}`
                    + ` B(${Beautify(data.entryPrice,2)}) → S(${Beautify(data.price,2)}) ${pctText}`;
                entry.textContent = entryText;
                entry.style.color = color;
            }
            else if (type === 'price') {
                const diff     = data.now - data.old;
                const newColor = diff < 0 ? '#8f8' : (diff > 0 ? '#f88' : '#fff');
                entry.innerHTML = `[${ts}] ${data.name}: `
                    + `<span style="color:#fff">${Beautify(data.old,2)}</span>`
                    + ` → `
                    + `<span style="color:${newColor}">${Beautify(data.now,2)}</span>`;
            }
            else {
                return;
            }

            this.logs.push(entry.textContent);
            const win = document.getElementById('AT-log-window');
            if (win) {
                win.appendChild(entry);
                win.scrollTop = win.scrollHeight;
            }
        }
    };

    Game.registerMod(AutoTraider.name, AutoTraider);
    window.AutoTraider = AutoTraider;
    AutoTraider.init();

})();
