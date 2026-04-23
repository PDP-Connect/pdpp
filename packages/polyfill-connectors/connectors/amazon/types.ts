// Parsed shapes for the Amazon connector. Extracted from index.ts so
// parsers.ts and tests can import them without pulling in the Playwright-
// flavored runtime entry.

export interface ListPageItem {
  asin: string | null;
  name: string;
  url: string | null;
}

export interface ListPageOrder {
  deliveryStatus: string | null;
  items: ListPageItem[];
  orderDateRaw: string | null;
  orderId: string;
  orderTotal: string | null;
}

export interface DetailItem {
  asin: string | null;
  item_image_url: string | null;
  name: string;
  quantity: number;
  refund_status: string | null;
  seller: string | null;
  unit_price: string | null;
  url: string | null;
}

export interface OrderDetail {
  digital_order: boolean;
  gift_order: boolean;
  grand_total: string | null;
  items: DetailItem[];
  payment_method_summary: string | null;
  recipient_name: string | null;
  shipping_address_summary: string | null;
  status_detail: string | null;
}

export interface MergedItem {
  asin?: string | null;
  item_image_url?: string | null;
  name: string;
  quantity?: number | null;
  refund_status?: string | null;
  seller?: string | null;
  unit_price?: string | null;
  url?: string | null;
}

export interface ListPageDiagnostics {
  any_card: number;
  any_order_header: number;
  body_preview: string;
  captcha: string;
  no_orders_text: string;
  order_cards: number;
  sign_in_form: boolean;
  title: string;
  url: string;
}
