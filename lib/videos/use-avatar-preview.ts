"use client";

import { useEffect, useState } from "react";
import { prepareAvatarVideoSource } from "./avatar-video";

type AvatarPreviewState = {
  source: string | null | undefined;
  url: string | null;
  error: string | null;
  loading: boolean;
};

export function useAvatarPreview(source: string | null | undefined) {
  const [state, setState] = useState<AvatarPreviewState>(() => ({
    source,
    url: null,
    error: null,
    loading: Boolean(source),
  }));

  useEffect(() => {
    if (!source) return;
    let active = true;
    let ownedUrl: string | null = null;

    void prepareAvatarVideoSource(source)
      .then((prepared) => {
        if (!active) {
          if (prepared.owned) URL.revokeObjectURL(prepared.url);
          return;
        }
        ownedUrl = prepared.owned ? prepared.url : null;
        setState({ source, url: prepared.url, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          source,
          url: null,
          error:
            error instanceof Error
              ? error.message
              : "The avatar preview could not be loaded.",
          loading: false,
        });
      });

    return () => {
      active = false;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
  }, [source]);

  if (state.source !== source) {
    setState({ source, url: null, error: null, loading: Boolean(source) });
  }
  return { url: state.url, error: state.error, loading: state.loading };
}
