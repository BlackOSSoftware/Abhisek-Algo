# Latest High / Low Grid — Strategy Explanation (Backtest Spec)

Yeh document **sirf backtest ke liye** strategy explain karta hai.  
Live / pehle se bani adaptive grid strategy pe iska koi impact nahi hona chahiye.

---

## 1) Time windows (IST)

| Phase | Time | Kaam |
|--------|------|------|
| Market open / observe start | **03:30** | Candle / price se din ka high-low banana shuru |
| Observation | **03:30 → 06:00** | Sirf **Day High** aur **Day Low** track; **trade nahi** |
| Trade start | **06:00** | Us waqt ke **latest extreme** se side choose karke grid start |
| Trade end | **12:30** | Uske baad nayi entry nahi |

Note: Broker ke M1 data kabhi ~06:30 se start hote hain. Us case me observation available bars se hoti hai; logic same rehti hai.

---

## 2) Latest High / Low ka matlab

Observation + session ke dauran continuously:

- **Day High** = aaj ka highest price (ab tak)
- **Day Low** = aaj ka lowest price (ab tak)
- **Latest extreme** = jo extreme **sabse last** bana

### Example (jo aapne diya)

1. **03:30** — market open ≈ **4400**
2. **05:00** — **4450** ka high bana → latest = **HIGH**
3. **05:30** — **4350** ka low bana → latest = **LOW** (kyunki ye baad me bana)
4. **06:00** — trade start → latest **LOW** hai  
   → **SELL side** se grid start

Agar baad me price wapas **Day High (4450)** pe aa jaye / naya high bane:

- Wahan **SELL nahi** lagenge
- **BUY side** start
- Market jitna upar jayega, **BUY** legs lagte jayenge

**Rule short:**  
`jidhar side se latest extreme hai, udhar se trade`  
Low latest → Sell side · High latest → Buy side

---

## 3) Grid rules (har side)

| Setting | Value |
|---------|--------|
| Lot size | **0.01** |
| Grid distance | **5 points** |
| Take profit (TP) | **10 points** |
| Max legs **per side** | **5** |
| Dono side mila ke | **5 sell + 5 buy = 10** (max possible) |

### Sell side (Day Low se)

- Anchor = **Day Low**
- Market low se **upar** aate hue har **5 point** pe SELL level  
  Example: low = 4350 → levels ≈ **4355, 4360, 4365, 4370, 4375** (5 legs)
- Har SELL ka target = entry se **10 point neeche** (TP 10)
- Ek time pe sell side pe max **5** open / pending legs

### Buy side (Day High se)

- Anchor = **Day High**
- Market high se **aur upar** jaate hue har **5 point** pe BUY level  
  Example: high = 4450 → levels ≈ **4455, 4460, 4465, 4470, 4475**
- Har BUY ka target = entry se **10 point upar** (TP 10)
- High pe sell nahi; buy side start
- Ek time pe buy side pe max **5** legs

### Important

- **Ek time pe nayi legs** sirf **active (latest) side** pe lagti hain
- Pehle low pe 5 sell lage, baad me high pe switch → 5 buy bhi lag sakte hain  
  → din bhar milake **10 tak** possible
- Side switch hone pe opposite side ki **pending** cancel; open positions TP / exit rules se manage

---

## 4) Overnight / same-day switches (compare karne ke liye)

Dono modes alag backtest se check karne hain:

### Switch A — Sell same-day cutoff (`sellCarryOvernight = false`)

- **12:30** pe **SELL** positions force close / cut
- **BUY** bhi session end pe cut
- Overnight carry **nahi**

### Switch B — Sell carry overnight (`sellCarryOvernight = true`)

- **SELL** next day tak carry ho sakte hain (TP / baad me exit)
- **BUY** phir bhi same day **12:30** pe cut
- Agle din naya observe (03:30–06:00) + naya latest side; purane carried sells alag se open reh sakte hain

---

## 5) Side switch behaviour (session ke andar)

1. Latest = Low → sirf **SELL** grid (low se upar)
2. Price Day High touch / naya high → active = **BUY**
3. Sell pending hatao; buy grid high se upar
4. Agar phir naya low bane → wapas **SELL** side

Har bar **jo extreme last print hua**, wahi active side.

---

## 6) Backtest checklist (implementation ke liye)

- [ ] Observe: 03:30 → 06:00 (trade off)
- [ ] Trade: 06:00 → 12:30
- [ ] Track Day High / Day Low + latest extreme
- [ ] Low latest → Sell grid above low (step 5, TP 10, max 5)
- [ ] High latest → Buy grid above high (step 5, TP 10, max 5)
- [ ] Lot = 0.01
- [ ] Switch: sell same-day cut vs sell overnight carry
- [ ] Buy always cut at 12:30
- [ ] Live / old strategy config **change mat karo** — isolated backtest only

---

## 7) One-line summary

**Subah open se 6 baje tak high-low banao; 6 baje se 12:30 tak jo extreme latest hai usi side se 5-point grid + 10 TP + max 5 legs (0.01 lot); high pe buy / low pe sell; sell overnight carry alag switch se test.**
