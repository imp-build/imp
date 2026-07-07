import { cargoPackage } from "//rules/rust";

export const hello = cargoPackage({
    bin: "hello",
});
