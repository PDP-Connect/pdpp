// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface ConsentApprovalReview {
  batch: boolean;
}

export function requireOneClickConsentApproval(review: ConsentApprovalReview): void {
  if (review.batch) {
    throw new Error("Batch approval requires hosted source review");
  }
}
