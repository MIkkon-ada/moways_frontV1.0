import sys, os
sys.path.insert(0, ".")
from app.routers.dashboard import _is_overdue, _plan_time_in_current_month
from datetime import date

today = date.today()
y, m = today.year, today.month
cur  = f"{y}-{m:02d}"
prev = f"{y}-{m-1:02d}" if m > 1 else f"{y-1}-12"
nxt  = f"{y}-{m+1:02d}" if m < 12 else f"{y+1}-01"

cases = [
    ("过去月 is_overdue",          _is_overdue(prev),                         True),
    ("当前月 is_overdue",          _is_overdue(cur),                          False),
    ("下个月 is_overdue",          _is_overdue(nxt),                          False),
    ("区间含当前月 in_current",    _plan_time_in_current_month(f"{prev}~{nxt}"), True),
    ("当前月 in_current",          _plan_time_in_current_month(cur),           True),
    ("过去月 in_current",          _plan_time_in_current_month(prev),          False),
    ("中文格式 is_overdue",        _is_overdue("2026年1月"),                   True),
    ("空值 is_overdue",            _is_overdue(""),                            False),
    ("空值 in_current",            _plan_time_in_current_month(""),            False),
]

all_pass = True
for name, got, want in cases:
    ok = got == want
    tag = "PASS" if ok else "FAIL"
    print(f"  [{tag}] {name}: {got}")
    if not ok:
        all_pass = False

print()
print("全部通过" if all_pass else "有失败项")
sys.exit(0 if all_pass else 1)
