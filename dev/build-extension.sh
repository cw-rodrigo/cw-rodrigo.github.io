#!/bin/sh
# Gera extensao/captura.zip (a extensão de captura de elemento) a partir de extensao/captura/.
set -e
cd "$(dirname "$0")/../extensao"
rm -f captura.zip
zip -qr -X captura.zip captura -x 'captura/index.html'
echo "extensao/captura.zip pronto"
