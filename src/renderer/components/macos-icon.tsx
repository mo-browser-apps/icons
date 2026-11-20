import type { IconState } from "@/components/icon-types"
import { IconStack } from "@/components/icon-stack"
import { GenerationHint } from "@/components/generation-hint"
import { SingleRefineIcon } from "@/components/single-refine-icon"
import { VariantPicker } from "@/components/variant-picker"

export function MacOSIcon({
  state,
  selected,
  onSelect,
  variants,
  baseIconSrc,
}: {
  state: IconState
  selected: number | null
  onSelect: (i: number) => void
  variants: (string | null)[]
  baseIconSrc?: string | null
}) {
  if (state === "refine") {
    return <SingleRefineIcon src={baseIconSrc} />
  }
  if (state === "generated") {
    return <VariantPicker selected={selected} onSelect={onSelect} variants={variants} />
  }
  return (
    <div className="flex max-w-full flex-col items-center">
      <IconStack state={state} />
      {state === "generating" && <GenerationHint />}
    </div>
  )
}
