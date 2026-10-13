"""Symbol universes for the screener (Indian markets only: NSE .NS and BSE .BO tickers)."""
from __future__ import annotations

NIFTY_50 = [
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV",
    "BEL", "BPCL", "BHARTIARTL", "BRITANNIA", "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL", "GRASIM",
    "HCLTECH", "HDFCBANK", "HDFCLIFE", "HEROMOTOCO", "HINDALCO", "HINDUNILVR", "ICICIBANK", "ITC", "INDUSINDBK",
    "INFY", "JSWSTEEL", "JIOFIN", "KOTAKBANK", "LT", "M&M", "MARUTI", "NTPC", "NESTLEIND", "ONGC", "POWERGRID",
    "RELIANCE", "SBILIFE", "SHRIRAMFIN", "SBIN", "SUNPHARMA", "TCS", "TATACONSUM", "TMPV", "TMCV", "TATASTEEL",
    "TECHM", "TITAN", "TRENT", "ULTRACEMCO", "WIPRO",
]

NIFTY_NEXT_50 = [
    "ABB", "ADANIENSOL", "ADANIGREEN", "ADANIPOWER", "AMBUJACEM", "DMART", "BAJAJHLDNG", "BAJAJHFL", "BANKBARODA",
    "BHEL", "BOSCHLTD", "CANBK", "CGPOWER", "CHOLAFIN", "DABUR", "DIVISLAB", "DLF", "GAIL", "GODREJCP", "HAVELLS",
    "HAL", "HINDZINC", "HYUNDAI", "ICICIGI", "ICICIPRULI", "INDHOTEL", "IOC", "IRFC", "INDIGO", "JINDALSTEL",
    "JSWENERGY", "LICI", "LODHA", "MOTHERSON", "NAUKRI", "PFC", "PIDILITIND", "PNB", "RECLTD", "SIEMENS",
    "SWIGGY", "TATAPOWER", "TORNTPHARM", "TVSMOTOR", "UNITDSPR", "VBL", "VEDL", "ZYDUSLIFE", "SHREECEM",
    "UNIONBANK", "ATGL", "PCJEWELLER",
]

SENSEX_30 = [
    "ADANIPORTS", "ASIANPAINT", "AXISBANK", "BAJFINANCE", "BAJAJFINSV", "BEL", "BHARTIARTL", "ETERNAL", "HCLTECH",
    "HDFCBANK", "HINDUNILVR", "ICICIBANK", "INFY", "ITC", "KOTAKBANK", "LT", "M&M", "MARUTI", "NTPC", "POWERGRID",
    "RELIANCE", "SBIN", "SUNPHARMA", "TCS", "TATASTEEL", "TECHM", "TITAN", "TRENT", "ULTRACEMCO", "TMPV",
]

# Sector of each name (NSE industry classification, shortened) - used to group the heat-map tiles.
# Symbols not listed here get their sector from Yahoo in the background, else "Other".
_SECTOR_GROUPS = {
    "Financials": ["AXISBANK", "BAJFINANCE", "BAJAJFINSV", "HDFCBANK", "HDFCLIFE", "ICICIBANK", "INDUSINDBK", "JIOFIN",
                   "KOTAKBANK", "SBILIFE", "SHRIRAMFIN", "SBIN", "BAJAJHLDNG", "BAJAJHFL", "BANKBARODA", "CANBK", "CHOLAFIN",
                   "ICICIGI", "ICICIPRULI", "IRFC", "LICI", "PFC", "PNB", "RECLTD", "UNIONBANK"],
    "IT": ["HCLTECH", "INFY", "TCS", "TECHM", "WIPRO"],
    "Oil & Gas": ["BPCL", "COALINDIA", "ONGC", "RELIANCE", "GAIL", "IOC", "ATGL"],
    "FMCG": ["BRITANNIA", "HINDUNILVR", "ITC", "NESTLEIND", "TATACONSUM", "DABUR", "GODREJCP", "UNITDSPR", "VBL"],
    "Auto": ["BAJAJ-AUTO", "EICHERMOT", "HEROMOTOCO", "M&M", "MARUTI", "TMPV", "TMCV", "BOSCHLTD", "HYUNDAI", "MOTHERSON", "TVSMOTOR"],
    "Healthcare": ["APOLLOHOSP", "CIPLA", "DRREDDY", "SUNPHARMA", "DIVISLAB", "TORNTPHARM", "ZYDUSLIFE"],
    "Metals": ["ADANIENT", "HINDALCO", "JSWSTEEL", "TATASTEEL", "HINDZINC", "JINDALSTEL", "VEDL"],
    "Power": ["NTPC", "POWERGRID", "ADANIENSOL", "ADANIGREEN", "ADANIPOWER", "JSWENERGY", "TATAPOWER"],
    "Capital Goods": ["BEL", "ABB", "BHEL", "CGPOWER", "HAL", "SIEMENS"],
    "Consumer Services": ["ETERNAL", "TRENT", "DMART", "INDHOTEL", "NAUKRI", "SWIGGY"],
    "Consumer Durables": ["ASIANPAINT", "TITAN", "HAVELLS", "PCJEWELLER"],
    "Cement": ["GRASIM", "ULTRACEMCO", "AMBUJACEM", "SHREECEM"],
    "Construction": ["LT"],
    "Telecom": ["BHARTIARTL"],
    "Services": ["ADANIPORTS", "INDIGO"],
    "Realty": ["DLF", "LODHA"],
    "Chemicals": ["PIDILITIND"],
}
SECTORS: dict[str, str] = {sym: sector for sector, syms in _SECTOR_GROUPS.items() for sym in syms}

# Liquid NSE mid- and small-caps: big intraday runs (10%+ from the open) mostly happen here, not in the NIFTY 100
MID_SMALL = [
    "ABCAPITAL", "ALKEM", "APLAPOLLO", "ASHOKLEY", "ASTRAL", "AUBANK", "AUROPHARMA", "BALKRISIND", "BANDHANBNK",
    "BANKINDIA", "BHARATFORG", "BIOCON", "COFORGE", "COLPAL", "CONCOR", "CUMMINSIND", "DIXON", "ESCORTS",
    "EXIDEIND", "FEDERALBNK", "GLENMARK", "GMRAIRPORT", "GODREJPROP", "HINDPETRO", "IDEA", "IDFCFIRSTB",
    "INDUSTOWER", "IRCTC", "JUBLFOOD", "KPITTECH", "LICHSGFIN", "LUPIN", "MAXHEALTH", "MPHASIS", "MRF",
    "MUTHOOTFIN", "NHPC", "NMDC", "OBEROIRLTY", "OFSS", "OIL", "PAGEIND", "PERSISTENT", "PETRONET", "PHOENIXLTD",
    "POLYCAB", "PRESTIGE", "SAIL", "SONACOMS", "SRF", "SUPREMEIND", "SUZLON", "TATACOMM", "TATAELXSI", "TORNTPOWER",
    "UPL", "VOLTAS", "YESBANK", "LTF", "M&MFIN", "POLICYBZR", "PAYTM", "NYKAA", "DELHIVERY", "KALYANKJIL", "BSE",
    "CDSL", "MCX", "ANGELONE", "HUDCO", "IREDA", "RVNL", "IRCON", "NBCC", "NCC", "RAILTEL", "COCHINSHIP", "MAZDOCK",
    "BEML", "BDL", "SJVN", "NATIONALUM", "HINDCOPPER", "JSL", "APARINDS", "KEI", "AMBER", "KAYNES", "CESC",
    "INDIANB", "IOB", "CENTRALBK", "UCOBANK", "MAHABANK", "RBLBANK", "KARURVYSYA", "CUB", "MANAPPURAM", "IIFL",
    "POONAWALLA", "CROMPTON", "BLUESTARCO", "WHIRLPOOL", "BATAINDIA", "RELAXO", "ABFRL", "RAYMOND", "PVRINOX",
    "DEEPAKNTR", "AARTIIND", "PIIND", "NAVINFLUOR", "TATACHEM", "GNFC", "CHAMBLFERT", "COROMANDEL", "RCF", "FACT",
    "IGL", "MGL", "LAURUSLABS", "GRANULES", "NATCOPHARM", "IPCALAB", "AJANTPHARM", "ABBOTINDIA", "SYNGENE",
    "METROPOLIS", "LALPATHLAB", "FORTIS", "APOLLOTYRE", "CEATLTD", "TIINDIA", "UNOMINDA", "ENDURANCE", "JKCEMENT",
    "RAMCOCEM", "DALBHARAT", "ACC", "ELECTCAST", "TITAGARH", "HFCL", "TEJASNET", "ROUTE", "SONATSOFTW", "LTTS",
    "CYIENT", "BSOFT", "ZENSARTECH", "MASTEK", "INOXWIND", "WAAREEENER", "PREMIERENE", "NETWEB", "GRSE",
    "DATAPATTNS", "ASTRAMICRO", "SOLARINDS", "LLOYDSME", "GPIL", "MOIL", "WELCORP", "JINDALSAW", "IEX", "RPOWER",
    "JPPOWER", "IFCI", "HCC", "NLCINDIA", "ENGINERSIN", "NAM-INDIA", "HDFCAMC",
]

NSE_INDICES = {"^NSEI": "NIFTY 50", "^NSEBANK": "BANK NIFTY", "^CNXIT": "NIFTY IT", "^INDIAVIX": "INDIA VIX"}
BSE_INDICES = {"^BSESN": "SENSEX", "^NSEI": "NIFTY 50", "^INDIAVIX": "INDIA VIX"}

UNIVERSES = {
    "nifty50": {"name": "NIFTY 50 (NSE)", "exchange": "NSE", "symbols": [s + ".NS" for s in NIFTY_50], "indices": NSE_INDICES},
    "nifty100": {"name": "NIFTY 100 (NSE)", "exchange": "NSE", "symbols": [s + ".NS" for s in NIFTY_50 + NIFTY_NEXT_50], "indices": NSE_INDICES},
    "midsmall": {"name": "Mid & small caps (NSE)", "exchange": "NSE", "symbols": [s + ".NS" for s in MID_SMALL], "indices": NSE_INDICES},
    "nse_all": {"name": "NIFTY 100 + mid & small caps (NSE)", "exchange": "NSE",
                "symbols": [s + ".NS" for s in dict.fromkeys(NIFTY_50 + NIFTY_NEXT_50 + MID_SMALL)], "indices": NSE_INDICES},
    "sensex30": {"name": "SENSEX 30 (BSE)", "exchange": "BSE", "symbols": [s + ".BO" for s in SENSEX_30], "indices": BSE_INDICES},
    "bse100": {"name": "NIFTY 100 names on BSE", "exchange": "BSE", "symbols": [s + ".BO" for s in NIFTY_50 + NIFTY_NEXT_50], "indices": BSE_INDICES},
}
