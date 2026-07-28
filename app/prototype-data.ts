export type Tone = "positive" | "negative" | "neutral";

export type Holding = {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  price: string;
  value: string;
  cost: string;
  quantityLine: string;
  dailyAmount: string;
  dailyPercent: string;
  dailyTone: Tone;
  totalAmount: string;
  totalPercent: string;
  totalTone: Tone;
  sort: {
    ticker: string;
    value: string;
    daily: string;
    total: string;
  };
};

export type Quote = {
  symbol: string;
  name: string;
  price: string;
  change: string;
  percent: string;
  tone: Tone;
  marketDate: string;
  sort: {
    ticker: string;
    price: string;
    change: string;
  };
};

export type PortfolioPrototype = {
  id: string;
  name: string;
  homeCurrency: string;
  value: string;
  cost: string;
  dailyAmount: string;
  dailyPercent: string;
  gainAmount: string;
  gainPercent: string;
  realisedAmount: string;
  realisedPercent: string;
  cash: string;
  holdings: Holding[];
  quotes: Quote[];
};

const ausStockHoldings: Holding[] = [
  {
    symbol: "PLS.AX",
    name: "Pilbara Minerals",
    exchange: "ASX",
    currency: "AUD",
    price: "A$4.265",
    value: "A$85,300.00",
    cost: "A$39,300.00",
    quantityLine: "A$1.965 × 20,000 shares",
    dailyAmount: "+A$2,500.00",
    dailyPercent: "+3.02%",
    dailyTone: "positive",
    totalAmount: "+A$46,000.00",
    totalPercent: "+117.05%",
    totalTone: "positive",
    sort: {
      ticker: "1",
      value: "8530000",
      daily: "302",
      total: "11705",
    },
  },
  {
    symbol: "MIN.AX",
    name: "Mineral Resources",
    exchange: "ASX",
    currency: "AUD",
    price: "A$54.60",
    value: "A$114,660.00",
    cost: "A$101,481.00",
    quantityLine: "A$48.324 × 2,100 shares",
    dailyAmount: "+A$2,225.99",
    dailyPercent: "+1.98%",
    dailyTone: "positive",
    totalAmount: "+A$13,179.00",
    totalPercent: "+12.99%",
    totalTone: "positive",
    sort: {
      ticker: "2",
      value: "11466000",
      daily: "198",
      total: "1299",
    },
  },
  {
    symbol: "RIO.AX",
    name: "Rio Tinto",
    exchange: "ASX",
    currency: "AUD",
    price: "A$162.95",
    value: "A$130,360.00",
    cost: "A$75,004.40",
    quantityLine: "A$93.756 × 800 shares",
    dailyAmount: "+A$2,367.99",
    dailyPercent: "+1.85%",
    dailyTone: "positive",
    totalAmount: "+A$55,355.60",
    totalPercent: "+73.80%",
    totalTone: "positive",
    sort: {
      ticker: "3",
      value: "13036000",
      daily: "185",
      total: "7380",
    },
  },
  {
    symbol: "DRO.AX",
    name: "DroneShield",
    exchange: "ASX",
    currency: "AUD",
    price: "A$2.075",
    value: "A$124,500.00",
    cost: "A$47,879.00",
    quantityLine: "A$0.79798 × 60,000 shares",
    dailyAmount: "+A$2,100.01",
    dailyPercent: "+1.72%",
    dailyTone: "positive",
    totalAmount: "+A$76,621.00",
    totalPercent: "+160.03%",
    totalTone: "positive",
    sort: {
      ticker: "4",
      value: "12450000",
      daily: "172",
      total: "16003",
    },
  },
  {
    symbol: "RMD.AX",
    name: "ResMed",
    exchange: "ASX",
    currency: "AUD",
    price: "A$27.885",
    value: "A$97,597.50",
    cost: "A$98,180.00",
    quantityLine: "A$28.051 × 3,500 shares",
    dailyAmount: "+A$1,592.50",
    dailyPercent: "+1.66%",
    dailyTone: "positive",
    totalAmount: "−A$582.50",
    totalPercent: "−0.59%",
    totalTone: "negative",
    sort: {
      ticker: "5",
      value: "9759750",
      daily: "166",
      total: "-59",
    },
  },
  {
    symbol: "CLW.AX",
    name: "Charter Hall Long WALE REIT",
    exchange: "ASX",
    currency: "AUD",
    price: "A$3.72",
    value: "A$122,760.00",
    cost: "A$138,833.22",
    quantityLine: "A$4.2071 × 33,000 shares",
    dailyAmount: "+A$1,320.00",
    dailyPercent: "+1.09%",
    dailyTone: "positive",
    totalAmount: "−A$16,073.22",
    totalPercent: "−11.58%",
    totalTone: "negative",
    sort: {
      ticker: "6",
      value: "12276000",
      daily: "109",
      total: "-1158",
    },
  },
  {
    symbol: "FMG.AX",
    name: "Fortescue",
    exchange: "ASX",
    currency: "AUD",
    price: "A$18.76",
    value: "A$88,172.00",
    cost: "A$58,388.00",
    quantityLine: "A$12.423 × 4,700 shares",
    dailyAmount: "+A$893.00",
    dailyPercent: "+1.02%",
    dailyTone: "positive",
    totalAmount: "+A$29,784.00",
    totalPercent: "+51.01%",
    totalTone: "positive",
    sort: {
      ticker: "7",
      value: "8817200",
      daily: "102",
      total: "5101",
    },
  },
  {
    symbol: "BHP.AX",
    name: "BHP Group",
    exchange: "ASX",
    currency: "AUD",
    price: "A$44.38",
    value: "A$79,884.00",
    cost: "A$72,540.00",
    quantityLine: "A$40.30 × 1,800 shares",
    dailyAmount: "−A$288.00",
    dailyPercent: "−0.36%",
    dailyTone: "negative",
    totalAmount: "+A$7,344.00",
    totalPercent: "+10.12%",
    totalTone: "positive",
    sort: {
      ticker: "8",
      value: "7988400",
      daily: "-36",
      total: "1012",
    },
  },
];

const quoteChanges: Record<string, string> = {
  "PLS.AX": "+0.125",
  "MIN.AX": "+1.06",
  "RIO.AX": "+2.97",
  "DRO.AX": "+0.035",
  "RMD.AX": "+0.455",
  "CLW.AX": "+0.04",
  "FMG.AX": "+0.19",
  "BHP.AX": "−0.16",
};

const quotePriceSort: Record<string, string> = {
  "PLS.AX": "4265",
  "MIN.AX": "5460",
  "RIO.AX": "16295",
  "DRO.AX": "2075",
  "RMD.AX": "27885",
  "CLW.AX": "372",
  "FMG.AX": "1876",
  "BHP.AX": "4438",
};

const ausStockQuotes: Quote[] = ausStockHoldings.map((holding) => ({
  symbol: holding.symbol,
  name: holding.name,
  price: holding.price,
  change: quoteChanges[holding.symbol],
  percent: holding.dailyPercent,
  tone: holding.dailyTone,
  marketDate: "29 Jul",
  sort: {
    ticker: holding.sort.ticker,
    price: quotePriceSort[holding.symbol],
    change: holding.sort.daily,
  },
}));

ausStockQuotes.push(
  {
    symbol: "AUDUSD=X",
    name: "Australian Dollar / US Dollar",
    price: "US$0.6584",
    change: "+0.0018",
    percent: "+0.27%",
    tone: "positive",
    marketDate: "29 Jul",
    sort: { ticker: "9", price: "6584", change: "27" },
  },
  {
    symbol: "XAUUSD=X",
    name: "Gold spot / US Dollar",
    price: "US$2,418.70",
    change: "−8.60",
    percent: "−0.35%",
    tone: "negative",
    marketDate: "29 Jul",
    sort: { ticker: "10", price: "241870", change: "-35" },
  },
);

export const portfolioPrototypes: PortfolioPrototype[] = [
  {
    id: "aus-stocks",
    name: "Aus Stocks",
    homeCurrency: "AUD",
    value: "A$1,266,663.50",
    cost: "A$1,004,240.12",
    dailyAmount: "+A$4,254.99",
    dailyPercent: "+0.34%",
    gainAmount: "+A$262,423.38",
    gainPercent: "+26.13%",
    realisedAmount: "+A$15,000.00",
    realisedPercent: "+39.91%",
    cash: "A$84,930.45",
    holdings: ausStockHoldings,
    quotes: ausStockQuotes,
  },
  {
    id: "aus-super",
    name: "Aus Super",
    homeCurrency: "AUD",
    value: "A$428,912.40",
    cost: "A$351,870.00",
    dailyAmount: "+A$1,104.65",
    dailyPercent: "+0.26%",
    gainAmount: "+A$77,042.40",
    gainPercent: "+21.90%",
    realisedAmount: "+A$8,220.00",
    realisedPercent: "+14.32%",
    cash: "A$18,450.00",
    holdings: ausStockHoldings.slice(1, 6),
    quotes: ausStockQuotes.slice(1, 8),
  },
  {
    id: "us-watch",
    name: "US Watch",
    homeCurrency: "AUD",
    value: "Not available",
    cost: "Not available",
    dailyAmount: "Not available",
    dailyPercent: "—",
    gainAmount: "Not available",
    gainPercent: "—",
    realisedAmount: "A$0.00",
    realisedPercent: "—",
    cash: "A$0.00",
    holdings: [],
    quotes: [
      {
        symbol: "MSFT",
        name: "Microsoft Corporation",
        price: "US$512.47",
        change: "+3.82",
        percent: "+0.75%",
        tone: "positive",
        marketDate: "29 Jul",
        sort: { ticker: "1", price: "51247", change: "75" },
      },
      {
        symbol: "BRK-B",
        name: "Berkshire Hathaway",
        price: "US$472.61",
        change: "−1.14",
        percent: "−0.24%",
        tone: "negative",
        marketDate: "29 Jul",
        sort: { ticker: "2", price: "47261", change: "-24" },
      },
      {
        symbol: "COST",
        name: "Costco Wholesale",
        price: "US$936.08",
        change: "+2.40",
        percent: "+0.26%",
        tone: "positive",
        marketDate: "29 Jul",
        sort: { ticker: "3", price: "93608", change: "26" },
      },
    ],
  },
];

export const overviewRows = [
  {
    id: "aus-stocks",
    name: "Aus Stocks",
    holdings: "8 holdings",
    value: "A$1,266,663.50",
    cost: "A$1,004,240.12",
    daily: "+A$4,254.99",
    dailyPercent: "+0.34%",
    total: "+A$262,423.38",
    totalPercent: "+26.13%",
    tone: "positive" as const,
  },
  {
    id: "aus-super",
    name: "Aus Super",
    holdings: "5 holdings",
    value: "A$428,912.40",
    cost: "A$351,870.00",
    daily: "+A$1,104.65",
    dailyPercent: "+0.26%",
    total: "+A$77,042.40",
    totalPercent: "+21.90%",
    tone: "positive" as const,
  },
  {
    id: "us-watch",
    name: "US Watch",
    holdings: "3 quotes · no holdings",
    value: "—",
    cost: "—",
    daily: "—",
    dailyPercent: "—",
    total: "—",
    totalPercent: "—",
    tone: "neutral" as const,
  },
];

export const historyBars = [
  "38%",
  "43%",
  "40%",
  "48%",
  "52%",
  "49%",
  "58%",
  "64%",
  "61%",
  "69%",
  "73%",
  "78%",
  "75%",
  "84%",
  "88%",
  "86%",
  "94%",
  "100%",
];
