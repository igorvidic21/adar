import { defineActions } from 'direct-vuex';
import { routeAssetsActionContext } from '@/store/routeAssets';
import Papa from 'papaparse';
import type { Asset } from '@sora-substrate/util/build/assets/types';
import { api } from '@soramitsu/soraneo-wallet-web';
import { LiquiditySourceTypes } from '@sora-substrate/liquidity-proxy';
import { XOR } from '@sora-substrate/util/build/assets/consts';
import { RouteAssetsSubscription, RecipientStatus } from './types';
import { FPNumber, Operation } from '@sora-substrate/util/build';
import { formatAddress } from '@/utils';

const actions = defineActions({
  processingNextStage(context) {
    const { commit } = routeAssetsActionContext(context);
    commit.progressCurrentStageIndex(1);
  },
  processingPreviousStage(context) {
    const { commit } = routeAssetsActionContext(context);
    commit.progressCurrentStageIndex(-1);
  },
  setInputToken(context, asset) {
    const { commit } = routeAssetsActionContext(context);
    commit.setInputToken(asset);
  },
  cancelProcessing(context) {
    const { commit, rootGetters, dispatch } = routeAssetsActionContext(context);
    dispatch.cleanSwapReservesSubscription();
    commit.clearData();
  },
  async updateRecipients(context, file?: File): Promise<void> {
    const { commit, rootGetters, dispatch, rootState } = routeAssetsActionContext(context);
    if (!file) {
      commit.clearData();
      return;
    }
    const assetsTable = rootGetters.assets.assetsDataTable;
    const findAsset = (assetName: string) => {
      return Object.values(assetsTable)?.find((item: Asset) => item.symbol === assetName.toUpperCase());
    };

    const data: Array<any> = [];
    const priceObject = rootState.wallet.account.fiatPriceAndApyObject;

    await Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      comments: '//',
      step: (row) => {
        // console.log((row.meta.cursor / file.size) * 100);
        const usd = row.data[2]?.replace(/,/g, '');
        const asset = findAsset(row.data[3]) || XOR;
        const amount = Number(usd) / Number(getAssetUSDPrice(asset, priceObject));
        data.push({
          name: row.data[0],
          wallet: row.data[1],
          usd: usd,
          asset: asset,
          amount: amount,
          status: api.validateAddress(row.data[1]) ? RecipientStatus.ADDRESS_VALID : RecipientStatus.ADDRESS_INVALID,
          id: (crypto as any).randomUUID(),
          isCompleted: false,
        });
      },
      complete: () => {
        // const result = results.data.map((data) => {
        //   return {
        //     name: data[0],
        //     wallet: data[1],
        //     usd: data[2],
        //     asset: findAsset(data[3]),
        //     amount: data[4],
        //     status: api.validateAddress(data[1]) ? RecipientStatus.ADDRESS_VALID : RecipientStatus.ADDRESS_INVALID,
        //     id: (crypto as any).randomUUID(),
        //   };
        // });
        commit.setData({ file, recipients: data });
        dispatch.subscribeOnReserves();
      },
    });
  },

  editRecipient(context, { id, name, wallet, usd, asset }): void {
    const { commit, rootState } = routeAssetsActionContext(context);
    const priceObject = rootState.wallet.account.fiatPriceAndApyObject;
    const amount = Number(usd) / Number(getAssetUSDPrice(asset, priceObject));
    commit.editRecipient({ id, name, wallet, usd, amount, asset });
  },

  subscribeOnReserves(context, sourceToken: Asset = XOR): void {
    const { commit, rootGetters, getters, dispatch } = routeAssetsActionContext(context);
    const liquiditySources = rootGetters.swap.swapLiquiditySource;
    const tokens = [...new Set<Asset>(getters.recipients.map((item) => item.asset))]
      .map((item: Asset) => item?.address)
      .filter((item) => item !== sourceToken.address);
    const currentsPulls = [] as Array<RouteAssetsSubscription>;

    dispatch.cleanSwapReservesSubscription();
    tokens.forEach(async (tokenAddress) => {
      const reservesSubscribe = api.swap
        .subscribeOnReserves(sourceToken.address, tokenAddress, liquiditySources as LiquiditySourceTypes)
        .subscribe((value) =>
          dispatch.setSubscriptionPayload({
            payload: value,
            inputAssetId: sourceToken.address,
            outputAssetId: tokenAddress,
          })
        );
      currentsPulls.push({
        liquidityReservesSubscription: reservesSubscribe,
        payload: null,
        paths: null,
        liquiditySources: null,
        assetAddress: tokenAddress,
      });
    });
    commit.setSubscriptions(currentsPulls);
  },

  async setSubscriptionPayload(context, { payload, inputAssetId, outputAssetId }): Promise<void> {
    const { state, rootState, getters, commit, dispatch } = routeAssetsActionContext(context);

    const { paths, liquiditySources } = api.swap.getPathsAndPairLiquiditySources(
      inputAssetId,
      outputAssetId,
      payload,
      rootState.swap.enabledAssets
    );
    const subscription = state.subscriptions.find((item) => item.assetAddress === outputAssetId);
    if (subscription) {
      subscription.paths = paths;
      subscription.liquiditySources = liquiditySources;
      subscription.payload = payload;
    }
    dispatch.updateTokenAmounts();
  },

  updateTokenAmounts(context): void {
    const { state, rootState, getters, commit } = routeAssetsActionContext(context);
    const priceObject = rootState.wallet.account.fiatPriceAndApyObject;
    const recipients = getters.recipients;
    recipients.forEach((recipient) => {
      const amount = Number(recipient.usd) / Number(getAssetUSDPrice(recipient.asset, priceObject));
      commit.setRecipientTokenAmount({ id: recipient.id, amount });
    });
  },

  async repeatTransaction(context, id): Promise<void> {
    const { getters, commit } = routeAssetsActionContext(context);
    const inputAsset = getters.inputToken;
    const recipient = getters.recipients.find((recipient) => recipient.id === id);
    if (!recipient) {
      return Promise.reject(new Error('Cant find transaction by this Id'));
    }
    commit.setRecipientStatus({
      id: recipient.id,
      status: RecipientStatus.PENDING,
    });
    const transferParams = getTransferParams(context, inputAsset, recipient);
    if (!transferParams) return Promise.reject(new Error('Cant find transaction by this Id'));
    const action = transferParams.action;
    await action()
      .then(() => {
        commit.setRecipientStatus({
          id: recipient.id,
          status: RecipientStatus.SUCCESS,
        });
        commit.setRecipientCompleted(recipient.id);
      })
      .catch(() => {
        commit.setRecipientStatus({
          id: recipient.id,
          status: RecipientStatus.FAILED,
        });
      });
  },

  async runAssetsRouting(context): Promise<void> {
    const { getters, commit } = routeAssetsActionContext(context);
    const inputAsset = getters.inputToken;
    const data = getters.incompletedRecipients.map((recipient) => {
      commit.setRecipientStatus({
        id: recipient.id,
        status: RecipientStatus.PENDING,
      });
      return getTransferParams(context, inputAsset, recipient);
    });
    // await executeBatchSwapAndSend(context, data);
    const transfers = data.filter((item) => item?.transfer);
    const swapAndSend = data.filter((item) => !item?.transfer);

    await executeBatchSwapAndSend(context, swapAndSend);
    await executeTransfer(context, transfers);
  },

  cleanSwapReservesSubscription(context): void {
    const { state, commit } = routeAssetsActionContext(context);
    const subscriptions = state.subscriptions;
    subscriptions.forEach((sub) => {
      sub.liquidityReservesSubscription.unsubscribe();
    });
    commit.setSubscriptions([]);
  },
});

function getAssetUSDPrice(asset, fiatPriceAndApyObject) {
  return FPNumber.fromCodecValue(fiatPriceAndApyObject[asset.address]?.price, 18).toFixed(2);
}

function getTransferParams(context, inputAsset, recipient) {
  const { rootState, getters, rootGetters } = routeAssetsActionContext(context);
  if (recipient.asset.address === inputAsset.address) {
    const priceObject = rootState.wallet.account.fiatPriceAndApyObject;
    const amount = Number(recipient.usd) / Number(getAssetUSDPrice(recipient.asset, priceObject));
    const transfer = api.api.tx.assets.transfer(
      inputAsset.address,
      recipient.wallet,
      new FPNumber(amount, inputAsset.decimals).toCodecString()
    );
    const formattedToAddress =
      recipient.wallet.slice(0, 2) === 'cn' ? recipient.wallet : formatAddress(recipient.wallet);
    const history = {
      symbol: recipient.asset.symbol,
      to: formattedToAddress,
      amount: `${amount}`,
      assetAddress: recipient.wallet,
      type: Operation.Transfer,
    };
    return {
      action: async () => await api.transfer(recipient.asset, recipient.wallet, amount),
      recipient,
      transfer: {
        extrinsic: transfer,
        history: history,
      },
    };
  } else {
    const subscription = getters.subscriptions.find((sub) => sub.assetAddress === recipient.asset.address);
    if (!subscription) return null;
    const { paths, payload, liquiditySources } = subscription;
    const tokenEquivalent =
      Number(recipient.usd) /
      Number(
        FPNumber.fromCodecValue(rootState.wallet.account.fiatPriceAndApyObject[recipient.asset.address]?.price, 18)
      );
    const { amount, fee, rewards, amountWithoutImpact } = getSwapParams(
      inputAsset,
      recipient.asset,
      tokenEquivalent,
      true,
      rootGetters.swap.swapLiquiditySource,
      paths,
      payload
    );
    return {
      action: async () =>
        await api.swap.executeSwapAndSend(
          recipient.wallet,
          inputAsset,
          recipient.asset,
          amount,
          tokenEquivalent,
          undefined,
          true
        ),
      recipient,
    };
  }
}

async function executeBatchSwapAndSend(context, data: Array<any>): Promise<any> {
  const { commit } = routeAssetsActionContext(context);

  async function processArray(transactions) {
    for (const tx of transactions) {
      await tx
        .action()
        .then(() => {
          commit.setRecipientStatus({
            id: tx.recipient.id,
            status: RecipientStatus.SUCCESS,
          });
          commit.setRecipientCompleted(tx.recipient.id);
        })
        .catch(() => {
          commit.setRecipientStatus({
            id: tx.recipient.id,
            status: RecipientStatus.FAILED,
          });
        });
    }
  }

  await processArray(data);
}

async function executeTransfer(context, data: Array<any>): Promise<any> {
  const { commit } = routeAssetsActionContext(context);
  if (data.length < 1) return;
  await api
    .submitExtrinsic(api.api.tx.utility.batchAll(data.map((item) => item.transfer.extrinsic)), api.account.pair, {
      symbol: data[0].recipient.asset.symbol,
      from: api.account.pair.address,
      assetAddress: data[0].recipient.asset.symbol,
      type: Operation.Transfer,
    })
    .then(() => {
      data.forEach((tr) => {
        commit.setRecipientStatus({
          id: tr.recipient.id,
          status: RecipientStatus.SUCCESS,
        });
        commit.setRecipientCompleted(tr.recipient.id);
      });
    })
    .catch((err) => {
      data.forEach((tr) => {
        commit.setRecipientStatus({
          id: tr.recipient.id,
          status: RecipientStatus.FAILED,
        });
      });
      throw new Error(err);
    });
}

function getSwapParams(tokenFrom, tokenTo, value, isExchangeB, liquiditySource, paths, payload) {
  return api.swap.getResult(
    tokenFrom as Asset,
    tokenTo as Asset,
    value,
    isExchangeB,
    [liquiditySource].filter(Boolean) as Array<LiquiditySourceTypes>,
    paths,
    payload
  );
}

export default actions;