#!/bin/bash
pkill -f "dist/main.js" 2>/dev/null; pkill -f "vite --port 5174" 2>/dev/null; echo stopped
