"""Start the Trading Analytics server:  python run.py  (then open http://127.0.0.1:8003)"""
import uvicorn

if __name__ == "__main__":
    # reload_dirs: restart only when the code in app/ changes (data/ and static/ change all the time)
    uvicorn.run("app.main:app", host="127.0.0.1", port=8003, reload=True, reload_dirs=["app"])
