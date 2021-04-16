# PARENT CHAIN
node ./tracker-server/index.js &
sleep 5
ACCOUNT_INDEX=0 STAKE=100000 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10
ACCOUNT_INDEX=1 STAKE=100000 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10
ACCOUNT_INDEX=2 STAKE=100000 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10
ACCOUNT_INDEX=3 STAKE=100000 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10
ACCOUNT_INDEX=4 STAKE=100000 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10

# CHILD CHAIN 1
GENESIS_CONFIGS_DIR=genesis-configs/sim-shard PORT=9010 P2P_PORT=6010 node ./tracker-server/index.js &
sleep 10
GENESIS_CONFIGS_DIR=genesis-configs/sim-shard PORT=9011 P2P_PORT=6011 ACCOUNT_INDEX=0 STAKE=250 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10
GENESIS_CONFIGS_DIR=genesis-configs/sim-shard PORT=9012 P2P_PORT=6012 ACCOUNT_INDEX=1 STAKE=250 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10
GENESIS_CONFIGS_DIR=genesis-configs/sim-shard PORT=9013 P2P_PORT=6013 ACCOUNT_INDEX=2 STAKE=250 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10

# CHILD CHAIN 2
GENESIS_CONFIGS_DIR=genesis-configs/sim-shard PORT=9020 P2P_PORT=6020 node ./tracker-server/index.js &
sleep 10
GENESIS_CONFIGS_DIR=genesis-configs/sim-shard PORT=9021 P2P_PORT=6021 ACCOUNT_INDEX=0 TRACKER_WS_ADDR=ws://localhost:6020 STAKE=250 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10
GENESIS_CONFIGS_DIR=genesis-configs/sim-shard PORT=9022 P2P_PORT=6022 ACCOUNT_INDEX=1 TRACKER_WS_ADDR=ws://localhost:6020 STAKE=250 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10
GENESIS_CONFIGS_DIR=genesis-configs/sim-shard PORT=9023 P2P_PORT=6023 ACCOUNT_INDEX=2 TRACKER_WS_ADDR=ws://localhost:6020 STAKE=250 CONSOLE_LOG=true ENABLE_DEV_CLIENT_API=true node ./client/index.js &
sleep 10
