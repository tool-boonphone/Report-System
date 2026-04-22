import { z } from "zod";
import { requirePermission, router } from "../_core/trpc";
import {
  listContracts,
  listContractFilterOptions,
  type ContractFilters,
  type ContractSort,
} from "../contractsDb";
import { SECTIONS } from "../../shared/const";

const sectionInput = z.enum(SECTIONS);
const filtersInput = z
  .object({
    search: z.string().optional(),
    status: z.string().optional(),
    debtType: z.string().optional(),
    partnerCode: z.string().optional(),
    dateField: z.enum(["submitDate", "approveDate"]).optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
  })
  .optional();
const sortInput = z
  .object({
    field: z
      .enum([
        "contractNo",
        "submitDate",
        "approveDate",
        "status",
        "customerName",
        "partnerCode",
      ])
      .optional(),
    dir: z.enum(["asc", "desc"]).optional(),
  })
  .optional();

export const contractsRouter = router({
  list: requirePermission("contract", "view")
    .input(
      z.object({
        section: sectionInput,
        filters: filtersInput,
        sort: sortInput,
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(10).max(200).default(50),
      }),
    )
    .query(({ input }) =>
      listContracts({
        section: input.section,
        filters: input.filters as ContractFilters | undefined,
        sort: input.sort as ContractSort | undefined,
        page: input.page,
        pageSize: input.pageSize,
      }),
    ),

  filterOptions: requirePermission("contract", "view")
    .input(z.object({ section: sectionInput }))
    .query(({ input }) => listContractFilterOptions(input.section)),
});
