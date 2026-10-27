# Medições de precisão (para desenvolvimento)

Nada aqui é carregado pelo site. São os scripts usados para **medir e calibrar** a cifragem automática
e a análise de timbre com sons gerados pelo próprio sintetizador do site, em que a resposta certa é conhecida.
Rodam no Node (18+), a partir desta pasta.

## Acordes e tom

```sh
node gerar-musicas.mjs 1 60                     # gera músicas de teste em songs/ (acordes, tom e afinação conhecidos)
DETUNE=1 node gerar-musicas.mjs 61 80           # mesmas, fora do Lá 440
node medir-acordes.mjs "" 31-60                 # % de acordes e tons certos (V=1 lista música a música, C=1 mostra confusões)
node treinar-modelos.mjs > modelos.json         # modelos de acorde aprendidos de acordes sintetizados (ENGS=other usa outros timbres)
node treinar-modelos-distorcao.mjs > dist.json  # o mesmo com guitarra distorcida
```

Os modelos e pesos que estão em `lib/audio/harmony.js` saíram daqui. Para não se enganar, ajuste em
`1-30` e confira em `31-80`, que não foram usadas no ajuste.

## Timbre (ganho e reverb)

```sh
node medir-timbre.mjs 31 > a.json && node medir-timbre.mjs 32 > b.json   # guitarras com distorção e reverb conhecidos
python3 ajustar-ganho.py a.json b.json                                     # ajusta em a, confere em b
```

`guitarras.mjs` gera a guitarra (corda física do sintetizador), a distorção, a caixa e o reverb com RT60 conhecido.
