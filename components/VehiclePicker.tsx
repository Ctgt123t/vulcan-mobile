// ============================================================================
// VehiclePicker (#14) — structured make/model/year intake, built ONCE and reused
// by every intake surface (Diagnose, Ask Vulcan, Inspection).
//
// Each field is a CONTROLLED combobox: it shows a dropdown of options, filters
// as you type, and ALWAYS accepts a typed value that isn't in the list
// (free-text) — an old/obscure vehicle is never trapped. Fed from self-hosted
// data (vpic-backed) via lib/vehicleOptions; fail-soft (empty options => the
// field is just a plain text input). Presentational/controlled — it does NOT
// read VehicleContext; each screen owns its state and passes value/onChange.
//
// Styled to the v2 "steel glass" language (lib/theme.ts): glass-fill input with
// a hairline rim, uppercase muted label, crisp corners.
// ============================================================================

import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, fonts, HIT_TARGET, radii, type } from "../lib/theme";
import {
  fetchMakes,
  fetchModels,
  filterOptions,
  yearOptions,
} from "../lib/vehicleOptions";

type ComboboxProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  // When true, filter `options` client-side by the typed value (model/year).
  // When false, the parent is already searching server-side (make).
  clientFilter?: boolean;
  loading?: boolean;
  onQueryChange?: (q: string) => void;
  onSelectOption?: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "number-pad";
  autoCapitalize?: "none" | "words" | "sentences" | "characters";
};

function Combobox({
  label,
  value,
  onChange,
  options,
  clientFilter = true,
  loading = false,
  onQueryChange,
  onSelectOption,
  placeholder,
  keyboardType,
  autoCapitalize,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const filtered = clientFilter ? filterOptions(options, value) : options;
  const showList = open && filtered.length > 0;

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label.toUpperCase()}</Text>
      <View>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={(t) => {
            onChange(t);
            onQueryChange?.(t);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Let the dropdown row's onPress win; a small delay so the tap registers
          // before the list unmounts on blur.
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          keyboardType={keyboardType ?? "default"}
          autoCapitalize={autoCapitalize ?? "none"}
          autoCorrect={false}
        />
        {loading ? (
          <ActivityIndicator
            size="small"
            color={colors.muted}
            style={styles.spinner}
          />
        ) : null}
      </View>
      {showList ? (
        <View style={styles.dropdown}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            style={styles.dropdownScroll}
          >
            {filtered.slice(0, 60).map((opt) => (
              <TouchableOpacity
                key={opt}
                style={styles.optionRow}
                activeOpacity={0.6}
                onPress={() => {
                  onChange(opt);
                  onSelectOption?.(opt);
                  setOpen(false);
                }}
              >
                <Text style={styles.optionText}>{opt}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

export type VehiclePickerRowProps = {
  year: string;
  make: string;
  model: string;
  onYear: (v: string) => void;
  onMake: (v: string) => void;
  onModel: (v: string) => void;
};

// The reusable three-field block: Make -> Model -> Year (approved order).
// Owns ONLY the option-fetching (makes search, models-by-make); the vehicle
// values live in the parent screen and flow through onYear/onMake/onModel.
export function VehiclePickerRow({
  year,
  make,
  model,
  onYear,
  onMake,
  onModel,
}: VehiclePickerRowProps) {
  const [makeOpts, setMakeOpts] = useState<string[]>([]);
  const [modelOpts, setModelOpts] = useState<string[]>([]);
  const [makeLoading, setMakeLoading] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const years = useRef(yearOptions()).current;

  // Curated makes on mount.
  useEffect(() => {
    let live = true;
    setMakeLoading(true);
    fetchMakes("")
      .then((m) => {
        if (live) setMakeOpts(m);
      })
      .finally(() => {
        if (live) setMakeLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  // (Re)load models whenever the make changes (and is non-empty). This fires for
  // BOTH a user pick and a VIN auto-fill, so the model list always matches the
  // current make.
  useEffect(() => {
    const m = make.trim();
    if (!m) {
      setModelOpts([]);
      return;
    }
    let live = true;
    setModelLoading(true);
    fetchModels(m)
      .then((ms) => {
        if (live) setModelOpts(ms);
      })
      .finally(() => {
        if (live) setModelLoading(false);
      });
    return () => {
      live = false;
    };
  }, [make]);

  return (
    <View style={styles.stack}>
      <Combobox
        label="Make"
        value={make}
        onChange={onMake}
        // Curated list is fetched once and prefix-filtered on-device (no
        // per-keystroke server call; the pool is only the ~47 common makes).
        // Selecting a make from the list clears the model (it depends on make);
        // free-typing does NOT clear it (avoids wiping mid-edit), and a VIN
        // auto-fill sets values at the parent so it never triggers this.
        onSelectOption={() => onModel("")}
        options={makeOpts}
        loading={makeLoading}
        clientFilter
        placeholder="Ford, Toyota…"
        autoCapitalize="words"
      />
      <Combobox
        label="Model"
        value={model}
        onChange={onModel}
        options={modelOpts}
        loading={modelLoading}
        clientFilter
        placeholder={make.trim() ? "Pick or type a model" : "Choose a make first"}
        autoCapitalize="words"
      />
      <Combobox
        label="Year"
        value={year}
        onChange={onYear}
        options={years}
        clientFilter
        placeholder="2015"
        keyboardType="number-pad"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  field: {},
  label: {
    fontSize: type.size.xs,
    fontFamily: fonts.sansSemibold,
    color: colors.muted,
    letterSpacing: 1.2,
    marginBottom: 7,
  },
  input: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: fonts.sans,
    color: colors.text,
    backgroundColor: colors.glassFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    borderRadius: radii.sm,
  },
  spinner: { position: "absolute", right: 12, top: 0, bottom: 0 },
  // Inline dropdown (kept in-flow so it isn't clipped by parent overflow in the
  // intake ScrollViews); pushes the next field down while open.
  dropdown: {
    marginTop: 4,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    borderRadius: radii.sm,
    overflow: "hidden",
  },
  dropdownScroll: { maxHeight: 200 },
  optionRow: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  optionText: {
    fontSize: 15,
    fontFamily: fonts.sans,
    color: colors.text,
  },
});
