from pathlib import Path

from app.database import Base, SessionLocal, engine
from app.excel_importer import import_excel_data


def main():
    excel_path = Path(__file__).resolve().parent.parent / "博维咨询2026升级工作推进计划表_V1.2.xlsx"
    if not excel_path.exists():
        raise FileNotFoundError(excel_path)

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        result = import_excel_data(db, excel_path, replace=True)
        print(result)
    finally:
        db.close()


if __name__ == "__main__":
    main()
