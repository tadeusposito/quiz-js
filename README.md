# Jovem Senador – Quiz em Tempo Real

## Estrutura
```
/           → celular dos participantes (escanear QR)
/presenter  → telão (você controla aqui)
/admin      → cadastro de questões
```

## Variáveis de ambiente (Railway)
| Variável | Valor padrão | Descrição |
|---|---|---|
| `PORT` | 3000 | Automático no Railway |
| `ADMIN_PIN` | 1234 | PIN para /admin |
| `PRESENTER_PIN` | 5678 | PIN para /presenter |

**Troque os PINs antes do evento!**

## Deploy no Railway
1. Faça upload deste projeto (ou conecte ao repositório GitHub)
2. Railway detecta Node.js automaticamente e usa `npm start`
3. Configure as variáveis de ambiente nas Settings do projeto
4. Pronto — a URL gerada pelo Railway é a URL do quiz

## Fluxo do evento
1. Acesse `/admin` → cadastre todas as questões antes
2. Projete `/presenter` no telão → insira o PIN do presenter
3. Mostre o QR Code para os participantes escanearem
4. Aguarde todos entrarem no lobby
5. Clique "Próxima Questão" para começar
6. Clique "Revelar Resposta" quando quiser mostrar o gabarito
7. Clique "Próxima Questão" novamente para avançar
8. Após a última questão, o ranking aparece automaticamente

## Notas técnicas
- Estado em memória: zero banco de dados
- Reconexão automática: se o celular de um participante cair, ao reconectar com o mesmo nome, o histórico é preservado
- Desempate: número de acertos → menor tempo acumulado de resposta
- Suporta: imagem (jpg, png, gif, webp) e vídeo (mp4, webm, mov) por questão
