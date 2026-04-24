export const DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN: string;

export interface DefaultPreRegisteredPublicClient {
  client_id: string;
  metadata: {
    client_name: string;
    token_endpoint_auth_method: string;
  };
}

export const DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS: readonly DefaultPreRegisteredPublicClient[];
