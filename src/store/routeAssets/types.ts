import { Asset } from '@sora-substrate/util/build/assets/types';
import { Subscription } from 'rxjs';
import type { QuotePaths, QuotePayload } from '@sora-substrate/liquidity-proxy/build/types';
import type { LiquiditySourceTypes } from '@sora-substrate/liquidity-proxy/build/consts';

export type Recipient = {
  name: string;
  wallet: string;
  usd: number;
  asset: Asset;
  amount?: number;
  status: string;
  id: string;
  isCompleted?: boolean;
};

export type RouteAssetsSubscription = {
  liquidityReservesSubscription: Subscription;
  payload: Nullable<QuotePayload>;
  paths: Nullable<QuotePaths>;
  liquiditySources: Nullable<LiquiditySourceTypes[]>;
  assetAddress: string;
};

export enum RecipientStatus {
  PENDING = 'Pending',
  FAILED = 'Failed',
  ADDRESS_INVALID = 'Address invalid',
  ADDRESS_VALID = 'Address valid',
  SUCCESS = 'Success',
}

export type RoutedToken = {
  token: Asset;
  amount: number;
};

export type ProcessingState = {
  currentStageIndex: number;
  inputToken: Asset;
  tokensRouted?: Array<RoutedToken>;
};

export type Stage = {
  title: string;
  component: string;
};

export type RouteAssetsState = {
  recipients: Array<Recipient>;
  file: Nullable<File>;
  subscriptions: Array<RouteAssetsSubscription>;
  processingState: ProcessingState;
};
