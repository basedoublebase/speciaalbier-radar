#!/bin/sh
# Start de Speciaalbier Radar op http://localhost:8642
cd "$(dirname "$0")"
echo "Open http://localhost:8642 in je browser (Ctrl+C om te stoppen)"
python3 -m http.server 8642
