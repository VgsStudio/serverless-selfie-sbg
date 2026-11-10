# Custos do Serverless Selfie SBG

Números para o slide 20 ("Quanto custa? E o Free Tier?"). Medidos em 10/11/2026.

## Resumo

| | Preço cheio | Com franquias permanentes |
|---|---|---|
| **Média por selfie** | **US$ 0,0004** | US$ 0,0002 (1.000/mês) · US$ 0,0001 (100/mês) |
| 100 selfies | US$ 0,04 | US$ 0,009 |
| 1.000 selfies | US$ 0,40 | US$ 0,19 |
| Selfies por US$ 1 | ~2.500 | — |

- Preço cheio = sem franquias e sem créditos.
- Franquias permanentes (todo mês, por conta): Step Functions 4.000 transições;
  Lambda 1 milhão de requisições e 400 mil GB-s. Elas são da conta inteira.

## Onde vai o dinheiro (preço cheio, 100 selfies)

| Serviço | Consumo | US$ | % |
|---|---|---|---|
| Step Functions | 800 transições | 0,0200 | 50% |
| Lambda (render) | 744 GB-s | 0,0099 | 25% |
| S3 → internet | 32 MB | 0,0028 | 7% |
| S3 (requisições) | 1.000 | 0,0027 | 7% |
| CloudFront | 850 requisições | 0,0021 | 5% |
| DynamoDB | 1.750 unidades | 0,0008 | 2% |
| API Gateway | 650 requisições | 0,0007 | 2% |
| Lambda (api e etapas) | 32 GB-s | 0,0004 | 1% |
| CloudWatch Logs | 0,5 MB | 0,0003 | 1% |
| Lambda (requisições) | 1.050 | 0,0002 | 1% |

**Ponto da palestra:** metade do custo é a **orquestração** (Step Functions), não o
processamento da imagem. As primeiras ~500 selfies do mês não pagam Step Functions por
causa da franquia (500 × 8 = 4.000 transições). Em volume alto, um workflow Express ou
menos estados mudam essa conta.

## Conferência oficial (AWS Pricing Calculator, via MCP)

1.000 selfies/mês, us-east-1, Lambda ARM sem Free Tier: **US$ 0,22/mês**
(render 0,10 · Step Functions 0,10 · API Gateway 0,01 · DynamoDB 0,01 · Lambdas da API 0,00).
A calculadora oficial desconta a franquia do Step Functions; sem ela, dá US$ 0,32, o
mesmo valor da calculadora do site para esses serviços.

- Estimativa com valores: https://calculator.aws/#/estimate?id=268180ce0b2def6db6543154588ce80833ac26b7

## Como foi medido

- **Consumo:** CloudWatch, 26 execuções do workflow em 10/11/2026.
  Por selfie: 2 renders de ~1.860 ms numa Lambda de 2 GB (ARM), claim ~124 ms e
  validação ~201 ms (256 MB), 8 transições de estado, ~6,5 chamadas à API (criar,
  ~4 consultas de status, resultado), ~0,32 MB de molduras baixadas.
- **Preços:** AWS Price List API, us-east-1, 10/11/2026. Lambda ARM US$ 0,0000133334/GB-s
  e US$ 0,20/milhão de requisições; Step Functions Standard US$ 0,000025/transição;
  HTTP API US$ 1,00/milhão; DynamoDB on-demand US$ 0,625/milhão WRU e US$ 0,125/milhão RRU;
  S3 US$ 0,005/1.000 PUT e US$ 0,0004/1.000 GET; S3 → internet US$ 0,09/GB;
  CloudFront América do Sul US$ 0,11/GB e US$ 0,022/10.000 HTTPS; Logs US$ 0,50/GB.
- **Fora da conta:** o alarme da DLQ, que cabe na franquia permanente do CloudWatch (10 alarmes):
  custo zero. A demo não tem dashboard do CloudWatch; o painel admin lê as métricas direto. Eventos do S3 no EventBridge não são cobrados.

## Onde está

- Calculadora interativa: https://serverless-selfie.vsoller.com.br/custos.html
- Código: `web/custos.html`, `web/custos.js` (preços e consumo no topo do JS)
- README, seção "Custos"
