// Окно подтверждения в стиле программы (вместо системного window.confirm).
// Использование: const confirm = useConfirm(); if (await confirm({ ... })) { ... }
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export interface ConfirmOptions {
  title: string
  text?: string
  confirmText?: string
  cancelText?: string
  /** Опасное действие: кнопка подтверждения красная. */
  danger?: boolean
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>

const Ctx = createContext<ConfirmFn>(() => Promise.resolve(false))

export function useConfirm(): ConfirmFn {
  return useContext(Ctx)
}

export function ConfirmProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(
    null
  )
  const okRef = useRef<HTMLButtonElement>(null)

  const confirm = useCallback<ConfirmFn>(
    (o) => new Promise<boolean>((resolve) => setState({ ...o, resolve })),
    []
  )

  const close = useCallback(
    (v: boolean) => {
      state?.resolve(v)
      setState(null)
    },
    [state]
  )

  useEffect(() => {
    if (!state) return
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, close])

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {state && (
        <div className="modal-back" onMouseDown={() => close(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3>{state.title}</h3>
            {state.text && <p className="muted">{state.text}</p>}
            <div className="modal-actions">
              <button onClick={() => close(false)}>{state.cancelText ?? 'Отмена'}</button>
              <button
                ref={okRef}
                className={state.danger ? 'btn-danger' : 'btn-primary'}
                onClick={() => close(true)}
              >
                {state.confirmText ?? 'Да'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}
