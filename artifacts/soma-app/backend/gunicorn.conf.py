# Gunicorn reads this file automatically when started from this directory
# (e.g. Render start command: `gunicorn app:app`).
#
# The default is ONE synchronous worker: while it waits on IntaSend for one
# learner's payment, every other request queues behind it. Threads let a
# worker serve other learners while one request waits on the network.
import os

workers = int(os.getenv("WEB_CONCURRENCY", "2"))
worker_class = "gthread"
threads = int(os.getenv("GUNICORN_THREADS", "4"))

# IntaSend calls time out after 25 s (intasend_client.py); give requests
# headroom beyond that instead of gunicorn's default 30 s hard kill.
timeout = 60
graceful_timeout = 30
keepalive = 5

bind = f"0.0.0.0:{os.getenv('PORT', '10000')}"
