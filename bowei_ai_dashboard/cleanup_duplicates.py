"""
清理 update_submissions 表中的重复提交记录。

判断重复的标准：
  同一提交人（submitter）+ 同一原文内容（transcript_text），保留 id 最小的那条（最早入库），
  删除其余所有副本。

用法：
  python cleanup_duplicates.py           # 预览，不删除
  python cleanup_duplicates.py --delete  # 实际删除
"""

import sys
import io
import sqlite3
from pathlib import Path
from collections import defaultdict

# Windows GBK 终端强制 UTF-8 输出
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

DB_PATH = Path(__file__).parent / "bowei_ai_dashboard.db"
DRY_RUN = "--delete" not in sys.argv


def main():
    if not DB_PATH.exists():
        print(f"数据库文件不存在：{DB_PATH}")
        sys.exit(1)

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    rows = cur.execute(
        "SELECT id, submitter, title, transcript_text, confirm_status, created_at "
        "FROM update_submissions ORDER BY id"
    ).fetchall()

    # 按 (submitter, transcript_text) 分组
    groups: dict[tuple, list] = defaultdict(list)
    for r in rows:
        key = (r["submitter"] or "", r["transcript_text"] or "")
        groups[key].append(dict(r))

    # 状态优先级：已确认 > 其他已处理 > 待确认（数字越小越优先保留）
    STATUS_PRIORITY = {"已确认": 0, "已退回": 1, "待确认": 2}

    def keep_key(r):
        return (STATUS_PRIORITY.get(r["confirm_status"], 9), r["id"])

    to_delete: list[int] = []
    dup_groups = {k: v for k, v in groups.items() if len(v) > 1}

    if not dup_groups:
        print("[OK] 没有发现重复记录，数据库干净。")
        con.close()
        return

    print(f"发现 {len(dup_groups)} 组重复记录：\n")
    for (submitter, text), group in dup_groups.items():
        group.sort(key=keep_key)
        keep = group[0]  # 状态最优先 + id 最小的保留
        victims = group[1:]
        preview = text[:60].replace("\n", " ") + ("…" if len(text) > 60 else "")
        print(f"  提交人: {submitter or '(未知)'}  原文: {preview}")
        print(f"    保留 id={keep['id']}  创建于 {keep['created_at']}  状态={keep['confirm_status']}")
        for v in victims:
            print(f"    删除 id={v['id']}   创建于 {v['created_at']}  状态={v['confirm_status']}")
            to_delete.append(v["id"])
        print()

    print(f"共需删除 {len(to_delete)} 条：{to_delete}")

    if DRY_RUN:
        print("\n[预览模式] 未执行删除。加 --delete 参数后重新运行即可实际清理。")
    else:
        placeholders = ",".join("?" * len(to_delete))
        cur.execute(f"DELETE FROM update_submissions WHERE id IN ({placeholders})", to_delete)
        con.commit()
        print(f"\n[OK] 已删除 {cur.rowcount} 条重复记录。")

    con.close()


if __name__ == "__main__":
    main()
